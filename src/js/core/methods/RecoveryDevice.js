/* @flow */

import AbstractMethod from './AbstractMethod';
import * as UI from '../../constants/ui';
import { validateParams } from './helpers/paramsValidator';
import type { CoreMessage } from '../../types';
import type { MessageType } from '../../types/trezor/protobuf';

export default class RecoveryDevice extends AbstractMethod {
    params: $ElementType<MessageType, 'RecoveryDevice'>;

    constructor(message: CoreMessage) {
        super(message);
        this.requiredPermissions = ['management'];
        this.useEmptyPassphrase = true;

        const { payload } = message;

        validateParams(payload, [
            { name: 'word_count', type: 'number' },
            { name: 'passphrase_protection', type: 'boolean' },
            { name: 'pin_protection', type: 'boolean' },
            { name: 'language', type: 'string' },
            { name: 'label', type: 'string' },
            { name: 'enforce_wordlist', type: 'boolean' },
            { name: 'type', type: 'number' },
            { name: 'u2f_counter', type: 'number' },
            { name: 'dry_run', type: 'boolean' },
        ]);
        this.params = {
            word_count: payload.word_count,
            passphrase_protection: payload.passphrase_protection,
            pin_protection: payload.pin_protection,
            language: payload.language,
            label: payload.label,
            enforce_wordlist: payload.enforce_wordlist,
            type: payload.type,
            u2f_counter: payload.u2f_counter,
            dry_run: payload.dry_run,
        };
        this.allowDeviceMode = [...this.allowDeviceMode, UI.INITIALIZE];
        this.useDeviceState = false;
    }

    async run() {
        const cmd = this.device.getCommands();
        const response = await cmd.typedCall('RecoveryDevice', 'Success', this.params);
        return response.message;
    }
}
