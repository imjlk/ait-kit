import { test } from 'bun:test';
import { createTossMtlsCore } from '../src';
import { checkRecipientContract } from './helpers/recipient-contract.mjs';

test('recipient privacy and numeric identity boundaries match the public package contract', async () => {
  await checkRecipientContract(createTossMtlsCore);
});
