import assert from 'node:assert/strict';

// Run unchanged against source and the isolated npm tarball's public export.
export async function checkRecipientContract(createCore) {
  const methods = ['promotionPrepareReward', 'promotionExecuteReward', 'promotionRewardStatus'];
  const base = { promotionCode: 'campaign', amount: 1, providerTransactionKey: 'tx-1', providerRequestId: 'request-1' };
  for (const recipient of [{userKey: 1}, {tossUserKey: '4113'}, {anonKey: '=synthetic-anon'}, {userKey: 'synthetic-long-user'}, {userKey: '  spaced-user  '}]) {
    const value = String(Object.values(recipient)[0]);
    for (const method of methods) {
      let calls = 0;
      const core = createCore({ mode: 'forward', upstreamBaseUrl: 'https://fixture.invalid', mtlsClient: {
        async request() {
          calls++;
          return Response.json({ resultType: 'FAIL', error: { errorCode: '4113', reason: `recipient ${value.trim()} rejected` } });
        }
      }});
      const result = await core[method]({...base, ...recipient});
      assert.equal(result.failureReason, '[redacted]');
      assert.equal(result.providerErrorCode, '4113');
      if (method !== 'promotionPrepareReward') assert.equal(result.providerTransactionKey, 'tx-1');
      assert.equal(calls, 1);
    }
  }
  for (const method of ['promotionExecuteReward', 'promotionRewardStatus']) {
    const core = createCore({mode:'forward', upstreamBaseUrl:'https://fixture.invalid', mtlsClient:{
      async request() { throw new Error('transport rejected synthetic-user'); }
    }});
    const result = await core[method]({...base,userKey:'synthetic-user'});
    assert.equal(result.failureReason,'[redacted]');
    assert.equal(result.result ?? result.status,'UNKNOWN');
    assert.equal(result.providerTransactionKey,'tx-1');
  }
  for (const mode of ['stub','forward']) {
    for (const field of ['userKey','tossUserKey']) {
      for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, NaN, Infinity]) {
        let calls = 0;
        const core = createCore({mode,upstreamBaseUrl:'https://fixture.invalid',mtlsClient:{
          async request() { calls++; return Response.json({}); }
        }});
        const recipient = {[field]:value};
        for (const method of methods) await assert.rejects(core[method]({...base,...recipient}),{code:'INVALID_PROMOTION_RECIPIENT'});
        await assert.rejects(core.smartMessageSend({...recipient,templateSetCode:'template',context:{}}),{code:'INVALID_MESSAGE_RECIPIENT'});
        await assert.rejects(core.smartMessageBulkSend({templateSetCode:'template',contextList:[{...recipient,context:{}}]}),{code:'INVALID_CONTEXT_RECIPIENT'});
        assert.equal(calls,0);
      }
    }
  }
  const seen = [];
  const core = createCore({mode:'forward',upstreamBaseUrl:'https://fixture.invalid',mtlsClient:{
    async request(_url,init) { seen.push(new Headers(init.headers).get('x-toss-user-key')); return Response.json({resultType:'SUCCESS',success:{key:'key'}}); }
  }});
  for (const value of [0,Number.MAX_SAFE_INTEGER,'9007199254740993']) await core.promotionPrepareReward({userKey:value});
  assert.deepEqual(seen,['0',String(Number.MAX_SAFE_INTEGER),'9007199254740993']);
}
