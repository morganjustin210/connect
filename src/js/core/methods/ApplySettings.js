/* @flow */

import AbstractMethod from './AbstractMethod';
import { validateParams } from './helpers/paramsValidator';

import type { CoreMessage } from '../../types';
import type { MessageType } from '../../types/trezor/protobuf';

export default class ApplySettings extends AbstractMethod {
    params: $ElementType<MessageType, 'ApplySettings'>;

    constructor(message: CoreMessage) {
        super(message);
        this.requiredPermissions = ['management'];
        this.useDeviceState = false;
        const { payload } = message;

        validateParams(payload, [
            { name: 'language', type: 'string' },
            { name: 'label', type: 'string' },
            { name: 'use_passphrase', type: 'boolean' },
            { name: 'homescreen', type: 'string' },
            { name: 'passphrase_source', type: 'number' },
            { name: 'passphrase_always_on_device', type: 'boolean' },
            { name: 'auto_lock_delay_ms', type: 'number' },
            { name: 'display_rotation', type: 'number' },
            { name: 'safety_checks', type: 'string' },
        ]);

        this.params = {
            language: payload.language,
            label: payload.label,
            use_passphrase: payload.use_passphrase,
            homescreen: payload.homescreen,
            passphrase_source: payload.passphrase_source,
            passphrase_always_on_device: payload.passphrase_always_on_device,
            auto_lock_delay_ms: payload.auto_lock_delay_ms,
            display_rotation: payload.display_rotation,
            safety_checks: payload.safety_checks,
        };
    }

    async run() {
        const cmd = this.device.getCommands();
        const response = await cmd.typedCall('ApplySettings', 'Success', this.params);
        return response.message;
    }
}
