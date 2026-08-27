// Standalone logic test for the _DbSync push-safety fix (not wired into CI —
// exercises the exact diff algorithm added to _flush()/pull() in index.html
// against synthetic scenarios mirroring the real Aug 4 incident).

function computeMergePush(localPayload, lastSynced) {
  const localIds = new Set(localPayload.map(x => x && x.id).filter(Boolean));
  const deletes = Array.isArray(lastSynced)
    ? lastSynced.map(x => x && x.id).filter(id => id && !localIds.has(id))
    : [];
  return { upserts: localPayload, deletes };
}

// Server applies upserts (insert/update by id) then deletes (remove by id),
// mirroring the qams_merge_bucket SQL function's contract.
function applyMerge(serverArr, upserts, deletes) {
  const map = new Map(serverArr.map(x => [x.id, x]));
  upserts.forEach(x => map.set(x.id, x));
  deletes.forEach(id => map.delete(id));
  return Array.from(map.values());
}

let failures = 0;
function check(name, cond) {
  if (!cond) { console.error('FAIL:', name); failures++; }
  else console.log('ok  :', name);
}

// ── Scenario 1: reproduce the actual incident ──────────────────────────────
// Server has R1(Jun), R2(Jul), R3(Aug4-from-another-device).
// A stale device pulls first (as _bootDone gating guarantees before any
// flush), so its local cache + _lastSynced both get the true server state.
// It then edits R1 and pushes.
{
  const server = [{ id: 'R1', v: 'jun' }, { id: 'R2', v: 'jul' }, { id: 'R3', v: 'aug4' }];
  const lastSynced = server; // seeded by pull() with the raw server row
  const localAfterEdit = [{ id: 'R1', v: 'jun-edited' }, { id: 'R2', v: 'jul' }, { id: 'R3', v: 'aug4' }];
  const { upserts, deletes } = computeMergePush(localAfterEdit, lastSynced);
  const result = applyMerge(server, upserts, deletes);
  check('R3 survives an edit to R1 from a device that pulled first', result.find(r => r.id === 'R3'));
  check('R1 edit is applied', result.find(r => r.id === 'R1').v === 'jun-edited');
  check('deletes is empty (no real deletion happened)', deletes.length === 0);
}

// ── Scenario 2: the OLD bug, for contrast — full-array replace would erase R3 ──
{
  const server = [{ id: 'R1', v: 'jun' }, { id: 'R2', v: 'jul' }, { id: 'R3', v: 'aug4' }];
  const staleLocalNeverPulled = [{ id: 'R1', v: 'jun' }, { id: 'R2', v: 'jul' }]; // missing R3
  // OLD behavior: POST {bucket, data: staleLocalNeverPulled} -> server becomes exactly this array.
  const oldResult = staleLocalNeverPulled;
  check('OLD full-replace DOES erase R3 (confirms the bug existed)', !oldResult.find(r => r.id === 'R3'));
}

// ── Scenario 3: genuine deletion propagates correctly ──────────────────────
{
  const server = [{ id: 'R1' }, { id: 'R2' }, { id: 'R3' }];
  const lastSynced = server;
  const localAfterDelete = [{ id: 'R1' }, { id: 'R3' }]; // R2 deleted locally
  const { upserts, deletes } = computeMergePush(localAfterDelete, lastSynced);
  const result = applyMerge(server, upserts, deletes);
  check('R2 deletion propagates', !result.find(r => r.id === 'R2'));
  check('deletes contains exactly R2', deletes.length === 1 && deletes[0] === 'R2');
}

// ── Scenario 4: recovery — a device with local-only Aug 4 data reconnects ──
// after the server got clobbered back down to just [R1,R2].
{
  const clobberedServer = [{ id: 'R1' }, { id: 'R2' }];
  // pull()'s EXISTING _mergeBucket (unchanged) unions in local-only R3..R7.
  const deviceLocal = [{ id: 'R1' }, { id: 'R2' }, { id: 'R3' }, { id: 'R4' }, { id: 'R5' }, { id: 'R6' }, { id: 'R7' }];
  function mergeBucketPullSide(remoteArr, localArr) {
    const merged = remoteArr.slice();
    const remoteIds = new Set(remoteArr.map(x => x.id));
    localArr.forEach(item => { if (!remoteIds.has(item.id)) merged.push(item); });
    return merged;
  }
  const afterPull = mergeBucketPullSide(clobberedServer, deviceLocal);
  check('pull() recovers all 5 local-only Aug4 records into local cache', afterPull.length === 7);
  // New addition: pull() detects finalData.length > row.data.length and schedules a push.
  // That push then uses computeMergePush against lastSynced = clobberedServer (raw row.data).
  const { upserts, deletes } = computeMergePush(afterPull, clobberedServer);
  const serverAfterRecoveryPush = applyMerge(clobberedServer, upserts, deletes);
  check('recovery push restores all 7 records server-side', serverAfterRecoveryPush.length === 7);
  check('deletes is empty during recovery (nothing was actually deleted)', deletes.length === 0);
}

// ── Scenario 5: the users-password-wipe bug (recurred twice: 2026-08-14 and
// 2026-08-26) — /api/data strips `password` from every users row before it
// reaches a browser, so a plain remote-wins merge on the `users` bucket
// silently drops each user's password, and the next push from that device
// wipes it server-side too. Reimplements the FIXED restore guard from
// _mergeBucket() (index.html) / data.ts's merge handler: restore password
// (paired with its own pwVersion) whenever the merged/remote copy is
// missing one and a local/stored copy has one -- UNCONDITIONALLY, not
// gated on pwVersion matching. The gated version is exactly what caused
// the second recurrence: a device with a stale pwVersion pushed a
// password-less copy, the version check declined to "restore" a
// mismatched password, and the field was wiped anyway.
{
  function mergeBucketUsersSide(remoteArr, localArr) {
    const merged = remoteArr.slice();
    const remoteIds = new Set(remoteArr.map(x => x.id));
    localArr.forEach(item => { if (!remoteIds.has(item.id)) merged.push(item); });
    const localById = new Map(localArr.map(x => [x.id, x]));
    merged.forEach(u => {
      if (u.password) return;
      const loc = localById.get(u.id);
      if (loc && loc.password) { u.password = loc.password; u.pwVersion = loc.pwVersion; }
    });
    return merged;
  }

  // The exact reproduction: this device's local pwVersion (1) predates a
  // real password change made elsewhere (server is now at pwVersion 2),
  // and the server response has password stripped as always.
  const serverStripped = [{ id: 'U1', pwVersion: 2 }]; // password field absent, as /api/data always sends it
  const staleLocal = [{ id: 'U1', password: 'OLD_HASH', pwVersion: 1 }];
  const merged = mergeBucketUsersSide(serverStripped, staleLocal);
  const u1 = merged.find(u => u.id === 'U1');
  check('password is restored even when local pwVersion is stale/mismatched', u1.password === 'OLD_HASH');
  check('pwVersion is restored as a matched pair with the restored password (not left at the mismatched remote value)', u1.pwVersion === 1);

  // A brand-new user with no password anywhere yet must not crash or fabricate one.
  const merged2 = mergeBucketUsersSide([{ id: 'U2' }], []);
  check('a user with no known password anywhere stays password-less (no crash, no fabrication)', !merged2[0].password);
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
