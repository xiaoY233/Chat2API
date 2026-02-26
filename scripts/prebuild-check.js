#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const requiredFiles = [
  'package.json',
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html'
];

const buildResources = [
  'build/icon.svg',
  'build/entitlements.mac.plist'
];

console.log('🔍 开始构建前检查...\n');

let hasErrors = false;

console.log('📦 检查必需文件:');
requiredFiles.forEach(file => {
  const filePath = path.join(__dirname, '..', file);
  if (fs.existsSync(filePath)) {
    console.log(`  ✅ ${file}`);
  } else {
    console.log(`  ❌ ${file} - 文件不存在`);
    hasErrors = true;
  }
});

console.log('\n🏗️  检查构建资源:');
buildResources.forEach(file => {
  const filePath = path.join(__dirname, '..', file);
  if (fs.existsSync(filePath)) {
    console.log(`  ✅ ${file}`);
  } else {
    console.log(`  ⚠️  ${file} - 文件不存在，将使用默认配置`);
  }
});

console.log('\n📋 检查 package.json 配置:');
try {
  const pkg = require('../package.json');
  
  const checks = [
    { name: 'name', value: pkg.name },
    { name: 'version', value: pkg.version },
    { name: 'description', value: pkg.description },
    { name: 'author', value: pkg.author?.name || pkg.author },
    { name: 'license', value: pkg.license },
    { name: 'appId', value: pkg.build?.appId },
    { name: 'productName', value: pkg.build?.productName }
  ];
  
  checks.forEach(check => {
    if (check.value) {
      console.log(`  ✅ ${check.name}: ${check.value}`);
    } else {
      console.log(`  ❌ ${check.name} - 未配置`);
      hasErrors = true;
    }
  });
} catch (err) {
  console.log(`  ❌ 无法读取 package.json: ${err.message}`);
  hasErrors = true;
}

console.log('\n' + '='.repeat(50));

if (hasErrors) {
  console.log('❌ 构建前检查失败，请修复上述问题后重试。');
  process.exit(1);
} else {
  console.log('✅ 构建前检查通过，可以开始构建。');
  process.exit(0);
}
