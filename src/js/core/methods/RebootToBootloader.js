/* @flow */

import AbstractMethod from './AbstractMethod';
import { getFirmwareRange } from './helpers/paramsValidator';
import * as UI from '../../constants/ui';
import type { CoreMessage } from '../../types';

export default class RebootToBootloader extends AbstractMethod {
    confirmed: ?boolean;

    constructor(message: CoreMessage) {
        super(message);

        this.allowDeviceMode = [UI.INITIALIZE, UI.SEEDLESS];
        this.skipFinalReload = true;
        this.keepSession = false;
        this.requiredPermissions = ['management'];
        this.info = 'Reboot to bootloader';
        this.useDeviceState = false;
        this.firmwareRange = getFirmwareRange(this.name, null, {
            '1': { min: '1.10.0', max: '0' },
            '2': { min: '0', max: '0' },
        });
    }

    async run() {
        const cmd = this.device.getCommands();
        const response = await cmd.typedCall('RebootToBootloader', 'Success');
        return response.message;
    }
}
