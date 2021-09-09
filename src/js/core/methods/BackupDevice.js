/* @flow */

import AbstractMethod from './AbstractMethod';
import type { CoreMessage } from '../../types';

export default class BackupDevice extends AbstractMethod {
    constructor(message: CoreMessage) {
        super(message);
        this.requiredPermissions = ['management'];
        this.useDeviceState = false;
    }

    async run() {
        const cmd = this.device.getCommands();
        const response = await cmd.typedCall('BackupDevice', 'Success');
        return response.message;
    }
}
