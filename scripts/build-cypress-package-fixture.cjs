/**
 * Builds cypress/fixtures/test-package.zip — a minimal Discord data
 * package used by data-package-import.cy.ts.
 *
 * Keep in sync with the authenticated user fixture at
 * cypress/fixtures/user.json (id 111222333444555666) so validatePackage
 * returns readOnly=false for the default "matched user" test.
 *
 * Run on demand:  node scripts/build-cypress-package-fixture.cjs
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const OUT = path.resolve(__dirname, '../cypress/fixtures/test-package.zip');
const OUT_MISMATCH = path.resolve(
  __dirname,
  '../cypress/fixtures/test-package-mismatched.zip',
);
const OUT_MANY = path.resolve(__dirname, '../cypress/fixtures/test-package-many.zip');
const OUT_INVALID = path.resolve(
  __dirname,
  '../cypress/fixtures/test-package-invalid.zip',
);

const HEADER = 'ID,Timestamp,Contents,Attachments';

function buildBasePackage({
  userId,
  username = 'discrub_tester',
  globalName = 'Discrub Tester',
}) {
  const zip = new JSZip();

  zip.file(
    'account/user.json',
    JSON.stringify({
      id: userId,
      username,
      global_name: globalName,
      avatar_hash: 'abc',
      email: 'test@example.com',
    }),
  );

  // Minimal 1x1 PNG so the avatar blob-url path is exercised in E2E.
  zip.file(
    'account/avatar.png',
    Buffer.from(
      '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D' +
        '494441547801636060000000000500010DA1A0390000000049454E44AE426082',
      'hex',
    ),
  );

  // Guild the user is still in (matches one in cypress/fixtures/guilds.json)
  zip.file(
    'servers/901000000000000001/guild.json',
    JSON.stringify({ id: '901000000000000001', name: 'Cypress Test Server' }),
  );

  // Guild the user has LEFT — triggers left-servers banner
  zip.file(
    'servers/999000000000000999/guild.json',
    JSON.stringify({ id: '999000000000000999', name: 'Abandoned Server' }),
  );

  zip.file(
    'messages/index.json',
    JSON.stringify({
      '200': 'general',
      '300': 'Direct Message with tester-friend#0',
      '400': 'Old Guild Channel',
    }),
  );

  // Guild text channel — writable
  zip.file(
    'messages/c200/channel.json',
    JSON.stringify({
      id: '200',
      type: 0,
      name: 'general',
      guild: { id: '901000000000000001', name: 'Cypress Test Server' },
    }),
  );
  zip.file(
    'messages/c200/messages.csv',
    [
      HEADER,
      '1001,2022-07-28 22:30:52.800000+00:00,hello world,',
      '1002,2022-07-28 22:31:00.000000+00:00,"with, comma",',
      '1003,2022-07-28 22:32:00.000000+00:00,"multi\nline content",',
      '1004,2022-08-01 10:00:00.000000+00:00,attached file,https://cdn.discordapp.com/attachments/200/1004/photo.png?ex=0',
    ].join('\n'),
  );

  // DM — writable
  zip.file(
    'messages/c300/channel.json',
    JSON.stringify({
      id: '300',
      type: 1,
      recipients: [userId, 'other-user'],
    }),
  );
  zip.file(
    'messages/c300/messages.csv',
    [HEADER, '2001,2022-09-01 00:00:00.000000+00:00,hey,'].join('\n'),
  );

  // Orphan channel (type 0 with no guild) — read-only
  zip.file(
    'messages/c400/channel.json',
    JSON.stringify({ id: '400', type: 0, name: 'Old Guild Channel' }),
  );
  zip.file(
    'messages/c400/messages.csv',
    [HEADER, '3001,2020-01-01 00:00:00.000000+00:00,old message,'].join('\n'),
  );

  // Activity dir — parser must NOT read this. Deflated, and its
  // compressed bytes get overwritten with garbage after zipping (see
  // corruptEntryPayload): inflating it would throw, so a clean import
  // proves the reader never inflates what it does not need (#269).
  // JSZip defaults to STORE, and fflate does not verify CRCs, so a
  // stored garbage entry would prove nothing.
  zip.file('activity/reporting.json', ACTIVITY_FILLER, { compression: 'DEFLATE' });

  return zip;
}

const ACTIVITY_FILLER = Array.from({ length: 512 }, (_, i) => `event-${i}-${(i * 7919) % 1000}`).join('\n');

/**
 * Overwrites the compressed payload of one entry in a finished archive.
 * Finds the local header by file name; JSZip writes sizes in the local
 * header (no data descriptor), so the payload starts right after the
 * header, name, and extra field.
 */
function corruptEntryPayload(buf, name) {
  const nameBytes = Buffer.from(name, 'utf8');
  for (let i = 0; i + 30 + nameBytes.length <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const fnl = buf.readUInt16LE(i + 26);
    const es = buf.readUInt16LE(i + 28);
    if (fnl !== nameBytes.length) continue;
    if (!buf.subarray(i + 30, i + 30 + fnl).equals(nameBytes)) continue;
    const compressedSize = buf.readUInt32LE(i + 18);
    const start = i + 30 + fnl + es;
    buf.fill(0xff, start, start + compressedSize);
    return;
  }
  throw new Error(`fixture entry not found: ${name}`);
}

/**
 * #271: the base package plus one busy guild channel (id 500, "busy")
 * holding 60 messages (ids 5001..5060), so a package purge spec can
 * exercise the every-50 progress line and the short wait after a 404.
 */
function buildManyPackage(opts) {
  const zip = buildBasePackage(opts);
  zip.file(
    'messages/c500/channel.json',
    JSON.stringify({
      id: '500',
      type: 0,
      name: 'busy',
      guild: { id: '901000000000000001', name: 'Cypress Test Server' },
    }),
  );
  const rows = [HEADER];
  for (let i = 1; i <= 60; i++) {
    const minute = String(i % 60).padStart(2, '0');
    const hour = String(10 + Math.floor(i / 60)).padStart(2, '0');
    rows.push(`${5000 + i},2023-03-01 ${hour}:${minute}:00.000000+00:00,busy message ${i},`);
  }
  zip.file('messages/c500/messages.csv', rows.join('\n'));

  // #270: a DM whose channel.json spells the type as a name, the way
  // some newer exports do, and a channel with no type, guild, or
  // recipients at all. The first must land under Direct Messages, the
  // second under Other.
  zip.file(
    'messages/c600/channel.json',
    JSON.stringify({ id: '600', type: 'DM', recipients: [opts.userId, 'named-friend'] }),
  );
  zip.file(
    'messages/c600/messages.csv',
    [HEADER, '6001,2023-04-01 00:00:00.000000+00:00,named type dm,'].join('\n'),
  );
  zip.file('messages/c700/channel.json', JSON.stringify({ id: '700', name: 'mystery' }));
  // The index names the new DM the way Discord does; 700 stays unnamed there.
  zip.file(
    'messages/index.json',
    JSON.stringify({
      '200': 'general',
      '300': 'Direct Message with tester-friend#0',
      '400': 'Old Guild Channel',
      '500': 'busy',
      '600': 'Direct Message with named-friend#0',
      '700': null,
    }),
  );
  zip.file(
    'messages/c700/messages.csv',
    [HEADER, '7001,2023-05-01 00:00:00.000000+00:00,no type at all,'].join('\n'),
  );
  return zip;
}

async function writeZip(zip, filepath, corrupt = 'activity/reporting.json') {
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  if (corrupt && zip.file(corrupt)) corruptEntryPayload(buf, corrupt);
  fs.writeFileSync(filepath, buf);
  console.log(
    `  ${path.relative(process.cwd(), filepath)}  (${buf.length.toLocaleString()} bytes)`,
  );
}

(async () => {
  console.log('Building Cypress data-package fixtures:');
  // Matches cypress/fixtures/user.json id
  await writeZip(buildBasePackage({ userId: '111222333444555666' }), OUT);
  // Different user ID — triggers soft-warn read-only mode
  await writeZip(
    buildBasePackage({
      userId: '999999999999999999',
      username: 'someone_else',
      globalName: 'Someone Else',
    }),
    OUT_MISMATCH,
  );
  // #271: base package plus a 60-message channel for the package purge spec
  await writeZip(buildManyPackage({ userId: '111222333444555666' }), OUT_MANY);
  // Invalid: no account/user.json
  {
    const zip = new JSZip();
    zip.file('messages/index.json', '{}');
    await writeZip(zip, OUT_INVALID);
  }
})();
