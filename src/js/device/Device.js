/* @flow */

import EventEmitter from 'events';
import type { Transport, TrezorDeviceInfoWithSession as DeviceDescriptor } from 'trezor-link';
import DeviceCommands from './DeviceCommands';

import type {
    Device as DeviceTyped,
    DeviceFirmwareStatus,
    Features,
    Deferred,
    FirmwareRelease,
    UnavailableCapabilities,
} from '../types';

import { UI, DEVICE, ERRORS, NETWORK } from '../constants';
import { create as createDeferred } from '../utils/deferred';
import DataManager from '../data/DataManager';
import { getAllNetworks } from '../data/CoinInfo';
import { getFirmwareStatus, getRelease } from '../data/FirmwareInfo';
import {
    parseCapabilities,
    getUnavailableCapabilities,
    parseRevision,
} from '../utils/deviceFeaturesUtils';
import { versionCompare } from '../utils/versionUtils';
import { initLog } from '../utils/debug';

// custom log
const _log = initLog('Device');

export type RunOptions = {
    // skipFinalReload - normally, after action, features are reloaded again
    //                   because some actions modify the features
    //                   but sometimes, you don't need that and can skip that
    skipFinalReload?: boolean,
    // waiting - if waiting and someone else holds the session, it waits until it's free
    //          and if it fails on acquire (because of more tabs acquiring simultaneously),
    //          it tries repeatedly
    waiting?: boolean,
    onlyOneActivity?: boolean,

    // cancel popup request when we are sure that there is no need to authenticate
    // Method gets called after run() fetch new Features but before trezor-link dispatch "acquire" event
    cancelPopupRequest?: Function,

    keepSession?: boolean,
    useEmptyPassphrase?: boolean,
};

const parseRunOptions = (options?: RunOptions): RunOptions => {
    if (!options) options = {};
    return options;
};

/**
 *
 *
 * @export
 * @class Device
 * @extends {EventEmitter}
 */
class Device extends EventEmitter {
    transport: Transport;

    originalDescriptor: DeviceDescriptor;

    hasDebugLink: boolean;

    unreadableError: ?string; // unreadable error like: HID device, LIBUSB_ERROR

    firmwareStatus: DeviceFirmwareStatus;

    firmwareRelease: ?FirmwareRelease;

    features: Features;

    featuresNeedsReload: boolean = false;

    deferredActions: { [key: string]: Deferred<void> } = {};

    runPromise: ?Deferred<void>;

    loaded: boolean = false;

    inconsistent: boolean = false;

    firstRunPromise: Deferred<boolean>;

    activitySessionID: ?string;

    commands: DeviceCommands;

    keepSession: boolean = false;

    instance: number = 0;

    internalState: string[] = [];

    externalState: string[] = [];

    unavailableCapabilities: UnavailableCapabilities = {};

    networkTypeState: string[] = [];

    constructor(transport: Transport, descriptor: DeviceDescriptor) {
        super();

        _log.enabled = DataManager.getSettings('debug');

        // === immutable properties
        this.transport = transport;
        this.originalDescriptor = descriptor;
        this.hasDebugLink = descriptor.debug;

        // this will be released after first run
        this.firstRunPromise = createDeferred();
    }

    static fromDescriptor(transport: Transport, originalDescriptor: DeviceDescriptor) {
        const descriptor = { ...originalDescriptor, session: null };
        try {
            const device: Device = new Device(transport, descriptor);
            return device;
        } catch (error) {
            _log.error('Device.fromDescriptor', error);
            throw error;
        }
    }

    static createUnacquired(
        transport: Transport,
        descriptor: DeviceDescriptor,
        unreadableError?: string,
    ) {
        const device = new Device(transport, descriptor);
        device.unreadableError = unreadableError;
        return device;
    }

    async acquire() {
        // will be resolved after trezor-link acquire event
        this.deferredActions[DEVICE.ACQUIRE] = createDeferred();
        this.deferredActions[DEVICE.ACQUIRED] = createDeferred();
        try {
            const sessionID = await this.transport.acquire(
                {
                    path: this.originalDescriptor.path,
                    previous: this.originalDescriptor.session,
                },
                false,
            );
            _log.warn('Expected session id:', sessionID);
            this.activitySessionID = sessionID;
            this.deferredActions[DEVICE.ACQUIRED].resolve();
            delete this.deferredActions[DEVICE.ACQUIRED];

            if (this.commands) {
                this.commands.dispose();
            }
            this.commands = new DeviceCommands(this, this.transport, sessionID);

            // future defer for trezor-link release event
            this.deferredActions[DEVICE.RELEASE] = createDeferred();
        } catch (error) {
            this.deferredActions[DEVICE.ACQUIRED].resolve();
            delete this.deferredActions[DEVICE.ACQUIRED];
            if (this.runPromise) {
                this.runPromise.reject(error);
            } else {
                throw error;
            }
            this.runPromise = null;
        }
    }

    async release() {
        if (this.isUsedHere() && !this.keepSession && this.activitySessionID) {
            if (this.commands) {
                this.commands.dispose();
                if (this.commands.callPromise) {
                    try {
                        await this.commands.callPromise;
                    } catch (error) {
                        this.commands.callPromise = undefined;
                    }
                }
            }
            try {
                await this.transport.release(this.activitySessionID, false, false);
                if (this.deferredActions[DEVICE.RELEASE])
                    await this.deferredActions[DEVICE.RELEASE].promise;
            } catch (err) {
                // empty
            }
        }
    }

    async cleanup() {
        this.removeAllListeners();
        // make sure that Device_CallInProgress will not be thrown
        this.runPromise = null;
        await this.release();
    }

    run(fn?: () => Promise<void>, options?: RunOptions) {
        if (this.runPromise) {
            _log.debug('Previous call is still running');
            throw ERRORS.TypedError('Device_CallInProgress');
        }

        options = parseRunOptions(options);

        this.runPromise = createDeferred(this._runInner.bind(this, fn, options));
        return this.runPromise.promise;
    }

    async override(error: Error) {
        if (this.deferredActions[DEVICE.ACQUIRE]) {
            await this.deferredActions[DEVICE.ACQUIRE].promise;
        }

        if (this.runPromise) {
            this.runPromise.reject(error);
            this.runPromise = null;
        }

        if (!this.keepSession && this.deferredActions[DEVICE.RELEASE]) {
            await this.deferredActions[DEVICE.RELEASE].promise;
        }
    }

    interruptionFromUser(error: Error) {
        _log.debug('+++++interruptionFromUser');
        if (this.commands) {
            this.commands.cancel();
            this.commands.dispose();
        }
        if (this.runPromise) {
            // reject inner defer
            this.runPromise.reject(error);
            this.runPromise = null;
        }
    }

    interruptionFromOutside() {
        _log.debug('+++++interruptionFromOutside');
        if (this.commands) {
            this.commands.dispose();
        }
        if (this.runPromise) {
            this.runPromise.reject(ERRORS.TypedError('Device_UsedElsewhere'));
            this.runPromise = null;
        }
    }

    async _runInner<X>(fn?: () => Promise<X>, options: RunOptions) {
        if (!this.isUsedHere() || this.commands.disposed || !this.getExternalState()) {
            // acquire session
            await this.acquire();

            // update features
            try {
                if (fn) {
                    await this.initialize(!!options.useEmptyPassphrase);
                } else {
                    // do not initialize while firstRunPromise otherwise `features.session_id` could be affected
                    // Corner-case: T1 + bootloader < 1.4.0 doesn't know the "GetFeatures" message yet and it will send no response to it
                    // transport response is pending endlessly, calling any other message will end up with "device call in progress"
                    // set the timeout for this call so whenever it happens "unacquired device" will be created instead
                    // next time device should be called together with "Initialize" (calling "acquireDevice" from the UI)
                    await Promise.race([
                        this.getFeatures(),
                        new Promise((resolve, reject) =>
                            setTimeout(() => reject(new Error('GetFeatures timeout')), 3000),
                        ),
                    ]);
                }
            } catch (error) {
                if (!this.inconsistent && error.message === 'GetFeatures timeout') {
                    // handling corner-case T1 + bootloader < 1.4.0 (above)
                    // if GetFeatures fails try again
                    // this time add empty "fn" param to force Initialize message
                    this.inconsistent = true;
                    return this._runInner(() => Promise.resolve({}), options);
                }
                this.inconsistent = true;
                await this.deferredActions[DEVICE.ACQUIRE].promise;
                this.runPromise = null;
                return Promise.reject(
                    ERRORS.TypedError(
                        'Device_InitializeFailed',
                        `Initialize failed: ${error.message}, code: ${error.code}`,
                    ),
                );
            }
        }

        // if keepSession is set do not release device
        // until method with keepSession: false will be called
        if (options.keepSession) {
            this.keepSession = true;
        }

        // wait for event from trezor-link
        await this.deferredActions[DEVICE.ACQUIRE].promise;

        // call inner function
        if (fn) {
            await fn();
        }

        // reload features
        if (this.loaded && this.features && !options.skipFinalReload) {
            await this.getFeatures();
        }

        // await resolveAfter(2000, null);
        if (
            (!this.keepSession && typeof options.keepSession !== 'boolean') ||
            options.keepSession === false
        ) {
            this.keepSession = false;
            await this.release();
        }

        if (this.runPromise) {
            this.runPromise.resolve();
        }
        this.runPromise = null;

        if (!this.loaded) {
            this.loaded = true;
            this.firstRunPromise.resolve(true);
        }
    }

    getCommands() {
        return this.commands;
    }

    setInstance(instance: number) {
        if (this.instance !== instance) {
            // if requested instance is different than current
            // and device wasn't released in previous call (example: interrupted discovery which set "keepSession" to true but never released)
            // clear "keepSession" and reset "activitySessionID" to ensure that "initialize" will be called
            if (this.keepSession) {
                this.activitySessionID = null;
                this.keepSession = false;
            }

            // T1: forget passphrase cached in internal state
            if (this.isT1() && this.useLegacyPassphrase()) {
                this.setInternalState(undefined);
            }
        }
        this.instance = instance;
    }

    getInstance() {
        return this.instance;
    }

    setInternalState(state?: string) {
        if (typeof state !== 'string') {
            delete this.internalState[this.instance];
        } else {
            this.internalState[this.instance] = state;
        }
    }

    getInternalState() {
        return this.internalState[this.instance];
    }

    setExternalState(state?: ?string) {
        if (typeof state !== 'string') {
            delete this.internalState[this.instance];
            delete this.externalState[this.instance];
        } else {
            this.externalState[this.instance] = state;
        }
    }

    getExternalState() {
        return this.externalState[this.instance];
    }

    async validateState(networkType?: string) {
        if (!this.features) return;
        const altMode = this._altModeChange(networkType);
        const expectedState = altMode ? undefined : this.getExternalState();
        const state = await this.commands.getDeviceState(networkType);
        const uniqueState = `${state}@${this.features.device_id || 'device_id'}:${this.instance}`;
        if (!this.useLegacyPassphrase() && this.features.session_id) {
            this.setInternalState(this.features.session_id);
        }
        if (expectedState && expectedState !== uniqueState) {
            return uniqueState;
        }
        if (!expectedState) {
            this.setExternalState(uniqueState);
        }
    }

    useLegacyPassphrase() {
        return !this.atLeast(['1.9.0', '2.3.0']);
    }

    async initialize(useEmptyPassphrase: boolean) {
        let payload;
        if (this.features) {
            const legacy = this.useLegacyPassphrase();
            const internalState = this.getInternalState();
            payload = {};
            if (!legacy && internalState) {
                payload.session_id = internalState;
            }
            if (legacy && !this.isT1()) {
                payload.state = internalState;
                if (useEmptyPassphrase) {
                    payload.skip_passphrase = useEmptyPassphrase;
                    payload.state = null;
                }
            }
        }

        const { message } = await this.commands.typedCall('Initialize', 'Features', payload);
        this._updateFeatures(message);
    }

    async getFeatures() {
        const { message } = await this.commands.typedCall('GetFeatures', 'Features', {});
        this._updateFeatures(message);
    }

    _updateFeatures(feat: Features) {
        const capabilities = parseCapabilities(feat);
        feat.capabilities = capabilities;
        const version = [feat.major_version, feat.minor_version, feat.patch_version];
        // capabilities could change in case where features was fetched with older version of messages.json which doesn't know this field
        const capabilitiesDidChange =
            this.features &&
            this.features.capabilities &&
            this.features.capabilities.join('') !== capabilities.join('');
        // check if FW version or capabilities did change
        if (versionCompare(version, this.getVersion()) !== 0 || capabilitiesDidChange) {
            this.unavailableCapabilities = getUnavailableCapabilities(
                feat,
                getAllNetworks(),
                DataManager.getConfig().supportedFirmware,
            );
            this.firmwareStatus = getFirmwareStatus(feat);
            this.firmwareRelease = getRelease(feat);
        }
        // GetFeatures doesn't return 'session_id'
        if (this.features && this.features.session_id && !feat.session_id) {
            feat.session_id = this.features.session_id;
        }
        // translate legacy field `pin_cached` to `unlocked`
        if (feat.pin_protection) {
            // $FlowIssue protobuf, pin_cached is available only in older messages
            feat.unlocked = typeof feat.unlocked === 'boolean' ? feat.unlocked : feat.pin_cached;
        } else {
            feat.unlocked = true;
        }
        // fix inconsistency of revision attribute between T1 and T2
        const revision = parseRevision(feat);
        feat.revision = revision;

        this.features = feat;
        this.featuresNeedsReload = false;
    }

    isUnacquired() {
        return this.features === undefined;
    }

    async updateDescriptor(upcomingDescriptor: DeviceDescriptor) {
        const originalSession = this.originalDescriptor.session;
        const upcomingSession = upcomingDescriptor.session;

        _log.debug(
            'updateDescriptor',
            'currentSession',
            originalSession,
            'upcoming',
            upcomingSession,
            'lastUsedID',
            this.activitySessionID,
        );

        if (!originalSession && !upcomingSession && !this.activitySessionID) {
            // no change
            return;
        }

        if (this.deferredActions[DEVICE.ACQUIRED]) {
            await this.deferredActions[DEVICE.ACQUIRED].promise;
        }

        if (!upcomingSession) {
            // corner-case: if device was unacquired but some call to this device was made
            // this will automatically change unacquired device to acquired (without deviceList)
            // emit ACQUIRED event to deviceList which will propagate DEVICE.CONNECT event
            if (this.listeners(DEVICE.ACQUIRED).length > 0) {
                this.emit(DEVICE.ACQUIRED);
            }
        }

        const methodStillRunning = this.commands && !this.commands.disposed;
        if (!upcomingSession && !methodStillRunning) {
            // released
            if (originalSession === this.activitySessionID) {
                // by myself
                _log.debug('RELEASED BY MYSELF');
                if (this.deferredActions[DEVICE.RELEASE]) {
                    this.deferredActions[DEVICE.RELEASE].resolve();
                    delete this.deferredActions[DEVICE.RELEASE];
                }
                this.activitySessionID = null;
            } else {
                // by other application
                _log.debug('RELEASED BY OTHER APP');
                this.featuresNeedsReload = true;
            }
            this.keepSession = false;
        } else if (upcomingSession === this.activitySessionID) {
            // acquired
            // TODO: Case where listen event will dispatch before this.transport.acquire (this.acquire) return ID

            // by myself
            _log.debug('ACQUIRED BY MYSELF');
            if (this.deferredActions[DEVICE.ACQUIRE]) {
                this.deferredActions[DEVICE.ACQUIRE].resolve();
                // delete this.deferred[ DEVICE.ACQUIRE ];
            }
        } else {
            // by other application
            _log.debug('ACQUIRED BY OTHER');
            this.interruptionFromOutside();
        }

        this.originalDescriptor = upcomingDescriptor;
    }

    disconnect() {
        // TODO: cleanup everything
        _log.debug('DISCONNECT CLEANUP!');
        // don't try to release
        if (this.deferredActions[DEVICE.RELEASE]) {
            this.deferredActions[DEVICE.RELEASE].resolve();
            delete this.deferredActions[DEVICE.RELEASE];
        }

        this.interruptionFromUser(ERRORS.TypedError('Device_Disconnected'));

        this.runPromise = null;
    }

    isBootloader() {
        return this.features && !!this.features.bootloader_mode;
    }

    isInitialized() {
        return this.features && !!this.features.initialized;
    }

    isSeedless() {
        return this.features && !!this.features.no_backup;
    }

    isInconsistent() {
        return this.inconsistent;
    }

    getVersion() {
        if (!this.features) return [];
        return [
            this.features.major_version,
            this.features.minor_version,
            this.features.patch_version,
        ];
    }

    atLeast(versions: string[] | string) {
        if (!this.features) return false;
        const modelVersion =
            typeof versions === 'string' ? versions : versions[this.features.major_version - 1];
        return versionCompare(this.getVersion(), modelVersion) >= 0;
    }

    isUsed() {
        return typeof this.originalDescriptor.session === 'string';
    }

    isUsedHere() {
        return this.isUsed() && this.originalDescriptor.session === this.activitySessionID;
    }

    isUsedElsewhere() {
        return this.isUsed() && !this.isUsedHere();
    }

    isRunning() {
        return !!this.runPromise;
    }

    isLoaded() {
        return this.loaded;
    }

    waitForFirstRun() {
        return this.firstRunPromise.promise;
    }

    getDevicePath() {
        return this.originalDescriptor.path;
    }

    needAuthentication() {
        if (this.isUnacquired() || this.isUsedElsewhere() || this.featuresNeedsReload) return true;
        if (this.features.bootloader_mode || !this.features.initialized) return true;
        const pin = this.features.pin_protection ? !!this.features.unlocked : true;
        // $FlowIssue protobuf, passphrase_cached available only in older messages
        const pass = this.features.passphrase_protection ? this.features.passphrase_cached : true;
        return pin && pass;
    }

    isT1() {
        return this.features ? this.features.major_version === 1 : false;
    }

    hasUnexpectedMode(allow: string[], require: string[]) {
        // both allow and require cases might generate single unexpected mode
        if (this.features) {
            // allow cases
            if (this.isBootloader() && !allow.includes(UI.BOOTLOADER)) {
                return UI.BOOTLOADER;
            }
            if (!this.isInitialized() && !allow.includes(UI.INITIALIZE)) {
                return UI.INITIALIZE;
            }
            if (this.isSeedless() && !allow.includes(UI.SEEDLESS)) {
                return UI.SEEDLESS;
            }

            // require cases
            if (!this.isBootloader() && require.includes(UI.BOOTLOADER)) {
                return UI.NOT_IN_BOOTLOADER;
            }
        }
        return null;
    }

    dispose() {
        this.removeAllListeners();
        if (this.isUsedHere() && this.activitySessionID) {
            try {
                if (this.commands) {
                    this.commands.cancel();
                }
                this.transport.release(this.activitySessionID, true, false);
            } catch (err) {
                // empty
            }
        }
    }

    getMode() {
        if (this.features.bootloader_mode) return 'bootloader';
        if (!this.features.initialized) return 'initialize';
        if (this.features.no_backup) return 'seedless';
        return 'normal';
    }

    // simplified object to pass via postMessage
    toMessageObject(): DeviceTyped {
        if (this.unreadableError) {
            return {
                type: 'unreadable',
                path: this.originalDescriptor.path,
                error: this.unreadableError, // provide error details
                label: 'Unreadable device',
            };
        }
        if (this.isUnacquired()) {
            return {
                type: 'unacquired',
                path: this.originalDescriptor.path,
                label: 'Unacquired device',
            };
        }
        const defaultLabel = 'My Trezor';
        const label =
            this.features.label === '' || !this.features.label ? defaultLabel : this.features.label;
        let status = this.isUsedElsewhere() ? 'occupied' : 'available';
        if (this.featuresNeedsReload) status = 'used';
        return {
            type: 'acquired',
            id: this.features.device_id || null,
            path: this.originalDescriptor.path,
            label,
            state: this.getExternalState(),
            status,
            mode: this.getMode(),
            firmware: this.firmwareStatus,
            firmwareRelease: this.firmwareRelease,
            features: this.features,
            unavailableCapabilities: this.unavailableCapabilities,
        };
    }

    _getNetworkTypeState() {
        return this.networkTypeState[this.instance];
    }

    _setNetworkTypeState(networkType: ?string) {
        if (typeof networkType !== 'string') {
            delete this.networkTypeState[this.instance];
        } else {
            this.networkTypeState[this.instance] = networkType;
        }
    }

    _altModeChange(networkType?: string) {
        const prevAltMode = this._isAltModeNetworkType(this._getNetworkTypeState());
        const nextAltMode = this._isAltModeNetworkType(networkType);

        // Update network type
        this._setNetworkTypeState(networkType);

        return prevAltMode !== nextAltMode;
    }

    // Is it a network type that requires the device to operate in an alternative state (ie: Cardano)
    _isAltModeNetworkType(networkType?: string) {
        return [NETWORK.TYPES.cardano].includes(networkType);
    }

    //
    async legacyForceRelease() {
        if (this.isUsedHere()) {
            await this.acquire();
            await this.getFeatures();
            await this.release();
        }
    }
}

export type IDevice = typeof Device.prototype;
export default Device;
