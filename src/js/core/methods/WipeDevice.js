/* @flow */

import AbstractMethod from './AbstractMethod';
import * as UI from '../../constants/ui';
import { getFirmwareRange } from './helpers/paramsValidator';
import type { CoreMessage } from '../../types';

export default class WipeDevice extends AbstractMethod {
    confirmed: ?boolean;

    constructor(message: CoreMessage) {
        super(message);

        this.allowDeviceMode = [UI.INITIALIZE, UI.SEEDLESS];
        this.useDeviceState = false;
        this.requiredPermissions = ['management'];
        this.firmwareRange = getFirmwareRange(this.name, null, this.firmwareRange);
        this.info = 'Wipe device';
    }

    async run() {
        const cmd = this.device.getCommands();
        const response = await cmd.typedCall('WipeDevice', 'Success');
        return response.message;
    }
}
