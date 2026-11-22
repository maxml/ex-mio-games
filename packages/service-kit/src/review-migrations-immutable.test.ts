import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * D-31 R2: a migration that has shipped is never edited; a change to a shipped table goes into a new,
 * forward migration. This pins the sha256 of every migration that shipped before the fix round
 * (1732800000000-EnvScopedKeys is the pre-2736a6e text). A new migration is added by a new file, and
 * its hash may then be added here; an edit of an existing file turns this red.
 * Mutation: edit any line of a listed migration (for example re-add the inbound_events primary key
 * change to 1732800000000-EnvScopedKeys) -> red, naming the file.
 */

const SHIPPED: Record<string, string> = {
  'engagement/1732200000000-Init.ts':
    'bf6673d72b0c74962562934175c9a06d262251bafe12ea0fa1dac4b06cb0618c',
  'engagement/1732200001000-AppRoleGrants.ts':
    '06fbdf409420bc2eb3cfaff2e38c38ab6c0e4e45beba7b96b2e19aa5ea5642d4',
  'engagement/1732200002000-IngestSchema.ts':
    'b869d85d8f0bac23d63805398e5029503d35e40dfbf4b570eac602da0b5a2bbd',
  'engagement/1732300000000-Store.ts':
    '1f517815a010de0b7c42132bc8e7086f35fc864a492cc99f2fc4a0f200ac8342',
  'engagement/1732400000000-StageBFixes.ts':
    'e0bad7ba746c1e1378e4a484ed5aed1e87a8d099c92582c0f2dd8c56138fba0f',
  'engagement/1732500000000-AuditIntents.ts':
    '79219667945eca228d3deda4522dfa613e6c45224eb4733a8d1805b929151c8d',
  'engagement/1732600000000-WorkQueueRls.ts':
    '7ab9d09d8a93025de7dc6ae56dce3852bb6ebbda1d4366fa1a067ec2ae9a94fc',
  'engagement/1732700000000-OperatorAudit.ts':
    'ace5aaa28532217fd2ed38fc3d3b77c24a1bc16252a4e51c57d00c5032ac80fa',
  'engagement/1732700000000-WorkQueueScanNoTenant.ts':
    'a40c8be2d1d1f8ddd4e4817d9714a1fe217ee800132e91dbb20682f0c279be02',
  'engagement/1732800000000-EnvScopedKeys.ts':
    '3ab618d85ac48621e415697ec0ab8d40c4c8f1c6c3703ef2f270868c837015bf',
  'engagement/1732900000000-DropEnvironmentDefaults.ts':
    'ba488658b9cf78d1f46c1e4cc7b61b53aca615586d5261fb753b64deb9c3af3d',
  'identity/1732200000000-Init.ts':
    '50c1ba5b44b0295c5b1e1a31c313b23f0688c329f23e582679258cbde22e0af1',
  'identity/1732200001000-AppRoleGrants.ts':
    '339f34e6e68fb06e609ab300b65a4562a0e4efdd8bb3e057883f98a05929fb28',
  'identity/1732200002000-TenantRowScope.ts':
    '518e2084769b5d3818b160ec716b30ef843a5dc581ec3694f0c568dbfb27a999',
  'identity/1732300000000-IdentityCore.ts':
    'e990c57523847c31fec379ab47b5d72e8987b13c242acac851d9daefd7ea0aae',
  'identity/1732300001000-AuditIntentsAndGrants.ts':
    '4a1e2dd14463b7d2531ef171a22e628d3dbb0622c615f6ea42aa1710cd1bda36',
  'identity/1732300002000-CredentialEnvironment.ts':
    '46961e8a2aa23498c50ac5fd384b24896add7eb0e62b02b8dd97e1f47c4343ee',
  'identity/1732300003000-InboxGrant.ts':
    '066415588494cb09242f66d56d2fe3204c3d16c94150bbc682cfa0b49e7b51fc',
  'identity/1732300004000-RewardApis.ts':
    '5527a6624c3eb12d31c9d036b3bebb3749211ff98fed3599a47c003dfdf719ff',
  'identity/1732300005000-LaunchJtiEnvironment.ts':
    '33683b2d994d5ff109895d4f627a6531b6f6fea9c99b8e0915dc16453715a786',
  'identity/1732900000000-DropEnvironmentDefaults.ts':
    '8340c6f87fc943dc096fd2d7ee8c4b7dc074bbbe248a8425ea920a55bb884242',
  'payments/1732200000000-Init.ts':
    '57af5386e3404e8ee73dfe2a661b72b7b4fe9535afea93384904449463e451ef',
  'payments/1732300000000-Ledger.ts':
    '880d8297c13d138dac27b46ccd0f7893212e8c977953d6d60ec76230a3ddd624',
  'payments/1732300001000-AppRoleGrants.ts':
    '334e729f0bfb435140247b4e58c0ba5c15c3a416fd1ce8ec55cd6a7e0154eb78',
  'payments/1732300002000-AuditIntents.ts':
    '9d3061fe08b8e2a7cc839c9f527bbeffc0364c2eb653924c45a1c058de7f5f46',
  'payments/1732900000000-DropEnvironmentDefaults.ts':
    '0beeb6a49f2307f5d33b0d4770cef6f08ace103657d74ea5ecc08d8bc6744245',
};

const APPS = join(__dirname, '..', '..', '..', 'apps');
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('D-31 R2 applied migrations are never edited', () => {
  it('MIG-IMMUTABLE-1 every migration that shipped before the fix round still has its original text', () => {
    const changed: string[] = [];
    for (const [rel, hash] of Object.entries(SHIPPED)) {
      const [app, file] = rel.split('/') as [string, string];
      if (sha(join(APPS, app, 'src', 'model', 'migrations', file)) !== hash) changed.push(rel);
    }
    expect(changed).toEqual([]);
  });

  it('MIG-IMMUTABLE-2 a migration file the list does not know was added after the fix round (newer than 1733)', () => {
    const unknown: string[] = [];
    for (const app of ['engagement', 'identity', 'payments']) {
      for (const f of readdirSync(join(APPS, app, 'src', 'model', 'migrations'))) {
        if (!/^\d{13}-.*\.ts$/.test(f) || f.endsWith('.test.ts')) continue;
        if (!(`${app}/${f}` in SHIPPED) && !f.startsWith('1733')) unknown.push(`${app}/${f}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
