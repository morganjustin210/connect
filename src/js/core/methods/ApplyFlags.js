/* @flow */

import AbstractMethod from './AbstractMethod';
import { validateParams } from './helpers/paramsValidator';

import type { CoreMessage } from '../../types';
import type { MessageType } from '../../types/trezor/protobuf';

export default class ApplyFlags extends AbstractMethod {
    params: $ElementType<MessageType, 'ApplyFlags'>;

    constructor(message: CoreMessage) {
        super(message);
        this.requiredPermissions = ['management'];
        this.useDeviceState = false;

        const { payload } = message;

        validateParams(payload, [{ name: 'flags', type: 'number', obligatory: true }]);

        this.params = {
            flags: payload.flags,
        };
    }

    async run() {
        const cmd = this.device.getCommands();
        const response = await cmd.typedCall('ApplyFlags', 'Success', this.params);
        return response.message;
    }
}
