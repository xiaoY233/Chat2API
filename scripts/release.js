#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const pkg = require('../package.json');

function runCommand(command, options = {}) {
  console.log(`\n> ${command}`);
  try {
    return execSync(command, { 
      stdio: 'inherit',
      ...options 
    });
  } catch (error) {
    console.error(`Command failed: ${command}`);
    process.exit(1);
  }
}

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

function validateVersion(version) {
  const semverRegex = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
  return semverRegex.test(version);
}

async function main() {
  console.log('='.repeat(50));
  console.log('Chat2API Release Script');
  console.log('='.repeat(50));
  console.log(`\nCurrent version: ${pkg.version}`);

  const versionType = await question(
    '\nSelect version bump type:\n' +
    '  1. patch (bug fixes)\n' +
    '  2. minor (new features)\n' +
    '  3. major (breaking changes)\n' +
    '  4. custom version\n' +
    '\nEnter choice (1-4): '
  );

  let newVersion;
  let versionArg;

  switch (versionType.trim()) {
    case '1':
      versionArg = 'patch';
      break;
    case '2':
      versionArg = 'minor';
      break;
    case '3':
      versionArg = 'major';
      break;
    case '4':
      newVersion = await question('Enter version (e.g., 1.2.3): ');
      if (!validateVersion(newVersion)) {
        console.error('Invalid version format. Use semver format (e.g., 1.2.3)');
        rl.close();
        process.exit(1);
      }
      versionArg = newVersion;
      break;
    default:
      console.error('Invalid choice');
      rl.close();
      process.exit(1);
  }

  console.log('\n--- Pre-release checks ---');

  const status = execSync('git status --porcelain', { encoding: 'utf8' });
  if (status.trim()) {
    console.error('Error: Working directory has uncommitted changes.');
    console.log('Please commit or stash your changes before releasing.');
    rl.close();
    process.exit(1);
  }
  console.log('Working directory is clean.');

  const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  console.log(`Current branch: ${branch}`);

  const confirm = await question(
    `\nThis will:\n` +
    `  1. Update version to ${versionArg}\n` +
    `  2. Create a git tag\n` +
    `  3. Push to GitHub\n` +
    `  4. Trigger GitHub Actions to build and release\n\n` +
    `Continue? (y/n): `
  );

  if (confirm.toLowerCase() !== 'y') {
    console.log('Release cancelled.');
    rl.close();
    process.exit(0);
  }

  rl.close();

  console.log('\n--- Starting release process ---');

  console.log('\n1. Updating version...');
  runCommand(`npm version ${versionArg} -m "chore: release v%s"`);

  console.log('\n2. Pushing to GitHub...');
  runCommand('git push');
  runCommand('git push --tags');

  console.log('\n' + '='.repeat(50));
  console.log('Release process initiated!');
  console.log('='.repeat(50));
  console.log('\nGitHub Actions will now build and publish the release.');
  console.log('Check progress at: https://github.com/chat2api/Chat2API-Manager/actions');
}

main().catch(console.error);
