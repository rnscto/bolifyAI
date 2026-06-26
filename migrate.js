import fs from 'fs';
import path from 'path';

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
}

let modifiedCount = 0;

walkDir('./src', (filePath) => {
  if (!filePath.endsWith('.js') && !filePath.endsWith('.jsx')) return;
  if (filePath.includes('apiClient.js') || filePath.includes('base44Client.js')) return;

  let content = fs.readFileSync(filePath, 'utf8');
  let originalContent = content;

  // 1. Replace imports
  // Matches: import { base44 } from '@/api/base44Client';
  // Matches: import { base44 } from '../../api/base44Client';
  content = content.replace(/import\s*\{\s*base44\s*\}\s*from\s*['"](.*?)base44Client['"]/g, "import { apiClient } from '$1apiClient'");

  // Also handle cases where they import something else alongside base44 (unlikely but possible)
  // or default imports if any exist.

  // 2. Replace usages
  content = content.replace(/base44\.entities\./g, 'apiClient.');
  content = content.replace(/base44\.functions\./g, 'apiClient.functions.');
  content = content.replace(/base44\.auth\./g, 'apiClient.auth.');
  content = content.replace(/base44\.integrations\./g, 'apiClient.integrations.');

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf8');
    modifiedCount++;
    console.log(`Updated ${filePath}`);
  }
});

console.log(`Successfully migrated ${modifiedCount} files.`);
