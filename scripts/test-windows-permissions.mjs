#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const maxBuffer = 1024 * 1024;
const timeout = 30_000;

function fail(message) {
  throw new Error(message);
}

function runPowerShell(script, path) {
  const result = spawnSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: { ...process.env, LEARNING_ACL_TEST_PATH: path },
      maxBuffer,
      timeout,
      windowsHide: true,
    },
  );
  if (result.error) fail(`PowerShell failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`PowerShell exited ${result.status}: ${(result.stderr || result.stdout).slice(0, 4096)}`);
  }
  return result.stdout;
}

if (process.platform !== 'win32') fail('this acceptance test must run on Windows');

const binary = process.argv[2];
if (!binary) fail('usage: node scripts/test-windows-permissions.mjs <compiled-cli-binary>');
if (!isAbsolute(binary)) fail('compiled CLI binary path must be absolute');

const tempRoot = mkdtempSync(join(tmpdir(), 'learning-windows-acl-'));
const home = join(tempRoot, '学习 数据 目录');
const artifacts = join(home, 'artifacts');
const artifactDirectory = join(artifacts, '内部 目录');
const artifactFile = join(artifactDirectory, '导出 文件.txt');
const exportDirectory = join(home, 'exports', '旧任务');
const exportFile = join(exportDirectory, '课程.txt');
const masterKeyPath = join(home, 'master.key');
const stateDbPath = join(home, 'state.db');
const qrPath = join(home, 'login-qr-00000000-0000-0000-0000-000000000000.png');
mkdirSync(home, { recursive: true });
mkdirSync(artifactDirectory, { recursive: true });
mkdirSync(exportDirectory, { recursive: true });
const initialMasterKey = randomBytes(32);
writeFileSync(masterKeyPath, initialMasterKey);
writeFileSync(stateDbPath, Buffer.alloc(0));
writeFileSync(artifactFile, 'existing artifact');
writeFileSync(exportFile, 'existing export');
writeFileSync(qrPath, 'expired fixture QR');

const makeLooseAcl = `
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('LEARNING_ACL_TEST_PATH')
$acl = Get-Acl -LiteralPath $path
$everyone = [System.Security.Principal.SecurityIdentifier]::new([System.Security.Principal.WellKnownSidType]::WorldSid, $null)
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$inheritance = [System.Security.AccessControl.InheritanceFlags]::None
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$type = [System.Security.AccessControl.AccessControlType]::Allow
$rule = New-Object -TypeName System.Security.AccessControl.FileSystemAccessRule -ArgumentList @($everyone, $rights, $inheritance, $propagation, $type)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
`;

const inspectAcl = `
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('LEARNING_ACL_TEST_PATH')
$acl = Get-Acl -LiteralPath $path
[PSCustomObject]@{
  Owner = $acl.Owner
  OwnerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  CurrentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  AreAccessRulesProtected = $acl.AreAccessRulesProtected
  Sddl = $acl.Sddl
  Access = @($acl.Access | ForEach-Object {
    [PSCustomObject]@{
      IdentityReference = $_.IdentityReference.Value
      IdentitySid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      FileSystemRights = [uint32]$_.FileSystemRights
      InheritanceFlags = [uint32]$_.InheritanceFlags
      PropagationFlags = [uint32]$_.PropagationFlags
      AccessControlType = [string]$_.AccessControlType
      IsInherited = $_.IsInherited
    }
  })
} | ConvertTo-Json -Compress -Depth 4
`;

const makeJunction = `
$ErrorActionPreference = 'Stop'
$junction = [Environment]::GetEnvironmentVariable('LEARNING_ACL_TEST_PATH')
$target = Join-Path ([System.IO.Path]::GetDirectoryName($junction)) 'junction 目标'
[void](New-Item -ItemType Directory -Path $target -Force)
[void](New-Item -ItemType Junction -Path $junction -Target $target)
`;

function inspect(path) {
  return JSON.parse(runPowerShell(inspectAcl, path));
}

function ownerOnlyViolations(parsed, path) {
  const expectedRights = 0x1f01ff; // FileSystemRights.FullControl
  const containerInherit = 1;
  const objectInherit = 2;
  const violations = [];
  if (parsed.OwnerSid !== parsed.CurrentUserSid) {
    violations.push(`owner is ${parsed.OwnerSid}, expected ${parsed.CurrentUserSid}`);
  }
  if (path === home && !parsed.AreAccessRulesProtected) violations.push('directory still inherits parent ACEs');
  if (parsed.Access.length !== 1) {
    violations.push(`has ${parsed.Access.length} ACEs: ${JSON.stringify(parsed.Access)}`);
    return violations;
  }

  const ace = parsed.Access[0];
  if (ace.IdentitySid !== parsed.CurrentUserSid) violations.push(`has ACE for ${ace.IdentitySid}`);
  if (ace.AccessControlType !== 'Allow') violations.push(`ACE type is ${ace.AccessControlType}`);
  if (ace.FileSystemRights !== expectedRights) violations.push(`rights are ${ace.FileSystemRights}, expected ${expectedRights}`);
  if (path === home) {
    if (ace.InheritanceFlags !== (containerInherit | objectInherit)) {
      violations.push(`inheritance flags are ${ace.InheritanceFlags}`);
    }
    if (ace.PropagationFlags !== 0) violations.push(`propagation flags are ${ace.PropagationFlags}`);
  }
  return violations;
}

function assertOwnerOnly(label, path) {
  const parsed = inspect(path);
  const violations = ownerOnlyViolations(parsed, path);
  if (violations.length > 0) fail(`${label} ${violations.join('; ')}`);
}

try {
  const looseTargets = [home, artifacts, artifactDirectory, artifactFile, exportDirectory, exportFile, masterKeyPath, stateDbPath, qrPath];
  for (const path of looseTargets) runPowerShell(makeLooseAcl, path);

  const loose = inspect(home);
  const looseViolations = ownerOnlyViolations(loose, home);
  if (!looseViolations.some((violation) => violation.includes('S-1-1-0'))) {
    fail(`loose fixture was not detected as insecure: ${JSON.stringify(loose.Access)}`);
  }
  const looseCore = inspect(masterKeyPath);
  if (!ownerOnlyViolations(looseCore, masterKeyPath).some((violation) => violation.includes('S-1-1-0'))) {
    fail(`explicit loose master.key ACE was not detected: ${JSON.stringify(looseCore.Access)}`);
  }
  console.log('ACL detector rejected the intentionally loose fixture');

  const init = spawnSync(binary, ['init', '--home', home], {
    encoding: 'utf8',
    maxBuffer,
    timeout,
    windowsHide: true,
  });
  if (init.error) fail(`CLI failed to start: ${init.error.message}`);
  if (init.status !== 0) {
    fail(`CLI init exited ${init.status}: ${(init.stderr || init.stdout).slice(0, 4096)}`);
  }

  if (!readFileSync(masterKeyPath).equals(initialMasterKey)) fail('init replaced the existing master.key');
  const reinitLooseTargets = [home, masterKeyPath, stateDbPath, artifactFile, exportFile];
  for (const suffix of ['state.db-wal', 'state.db-shm']) {
    const path = join(home, suffix);
    if (existsSync(path)) reinitLooseTargets.push(path);
  }
  for (const path of reinitLooseTargets) runPowerShell(makeLooseAcl, path);

  const masterKey = readFileSync(masterKeyPath);
  const secondInit = spawnSync(binary, ['init', '--home', home], {
    encoding: 'buffer',
    maxBuffer,
    timeout,
    windowsHide: true,
  });
  if (secondInit.error) fail(`second CLI failed to start: ${secondInit.error.message}`);
  if (secondInit.status !== 0) {
    fail(`second CLI init exited ${secondInit.status}: ${String(secondInit.stderr || secondInit.stdout).slice(0, 4096)}`);
  }
  if (!readFileSync(masterKeyPath).equals(masterKey)) fail('second init replaced master.key');

  const targets = new Map([
    ['data directory', home],
    ['master.key', masterKeyPath],
    ['state.db', stateDbPath],
    ['artifacts directory', artifacts],
    ['artifacts nested directory', artifactDirectory],
    ['artifacts file', artifactFile],
    ['exports directory', exportDirectory],
    ['exports file', exportFile],
    ['residual login QR', qrPath],
  ]);
  for (const suffix of ['state.db-wal', 'state.db-shm']) {
    const path = join(home, suffix);
    if (existsSync(path)) targets.set(suffix, path);
  }
  for (const [label, path] of targets) assertOwnerOnly(label, path);

  const lockPath = join(home, 'learning.lock');
  writeFileSync(lockPath, String(process.pid));
  runPowerShell(makeLooseAcl, lockPath);
  const unlock = spawnSync(binary, ['profile', 'unlock', '--home', home], {
    encoding: 'utf8',
    maxBuffer,
    timeout,
    windowsHide: true,
  });
  if (unlock.error) fail(`locked CLI failed to start: ${unlock.error.message}`);
  if (unlock.status === 0) fail('profile unlock unexpectedly accepted a live writer lock');
  assertOwnerOnly('learning.lock', lockPath);

  const junction = join(tempRoot, '数据 junction');
  const junctionTarget = join(tempRoot, 'junction 目标');
  runPowerShell(makeJunction, junction);
  runPowerShell(makeLooseAcl, junctionTarget);
  writeFileSync(join(junctionTarget, 'marker.txt'), 'external target');
  const junctionInit = spawnSync(binary, ['init', '--home', junction], {
    encoding: 'utf8',
    maxBuffer,
    timeout,
    windowsHide: true,
  });
  if (junctionInit.error) fail(`junction CLI failed to start: ${junctionInit.error.message}`);
  if (junctionInit.status === 0) fail('CLI accepted a reparse point as the data directory');
  const junctionOutput = `${junctionInit.stderr}${junctionInit.stdout}`;
  if (!junctionOutput.includes('reparse point')) {
    fail(`junction rejection did not identify the reparse point: ${junctionOutput.slice(0, 4096)}`);
  }
  const junctionTargetAcl = inspect(junctionTarget);
  if (!ownerOnlyViolations(junctionTargetAcl, junctionTarget).some((violation) => violation.includes('S-1-1-0'))) {
    fail(`CLI followed or modified a junction target: ${JSON.stringify(junctionTargetAcl.Access)}`);
  }
  if (!existsSync(join(junctionTarget, 'marker.txt'))) fail('CLI modified the rejected junction target');

  console.log('Windows owner-only data directory ACL verified');
} catch (error) {
  console.error(`windows permissions: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
