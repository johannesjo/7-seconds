#!/usr/bin/env node

/**
 * Syncs package.json version to Android build.gradle.
 * Called automatically by npm's "version" lifecycle script.
 *
 * - Sets versionName to the new package.json version
 * - Increments versionCode by 1
 */

const fs = require('fs');
const path = require('path');

const gradlePath = path.resolve(__dirname, '../android/app/build.gradle');
const pkg = require('../package.json');

let gradle = fs.readFileSync(gradlePath, 'utf8');

// Bump versionCode by 1
gradle = gradle.replace(/versionCode (\d+)/, (_, code) => {
  const next = parseInt(code, 10) + 1;
  console.log(`  versionCode: ${code} → ${next}`);
  return `versionCode ${next}`;
});

// Set versionName to package.json version
gradle = gradle.replace(/versionName ".*?"/, () => {
  console.log(`  versionName: → "${pkg.version}"`);
  return `versionName "${pkg.version}"`;
});

fs.writeFileSync(gradlePath, gradle, 'utf8');
console.log('Android build.gradle version synced.');
