import webpush from 'web-push';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../../.env');

// Generate VAPID keys
const vapidKeys = webpush.generateVAPIDKeys();

console.log('\n=== VAPID Keys Generated ===\n');
console.log('Public Key:');
console.log(vapidKeys.publicKey);
console.log('\nPrivate Key:');
console.log(vapidKeys.privateKey);
console.log('\n=== Keys (for .env file) ===\n');
console.log(`VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:team@pydasoft.in\n`);

// Try to update .env file if it exists
if (fs.existsSync(envPath)) {
  let envContent = fs.readFileSync(envPath, 'utf8');
  
  // Update or add VAPID keys
  const updateEnvVar = (key, value) => {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  };
  
  updateEnvVar('VAPID_PUBLIC_KEY', vapidKeys.publicKey);
  updateEnvVar('VAPID_PRIVATE_KEY', vapidKeys.privateKey);
  
  // Only add VAPID_SUBJECT if it doesn't exist
  if (!envContent.includes('VAPID_SUBJECT=')) {
    envContent += '\nVAPID_SUBJECT=mailto:team@pydasoft.in';
  }
  
  fs.writeFileSync(envPath, envContent.trim() + '\n');
  console.log('✅ VAPID keys have been automatically added to your .env file!');
  console.log('⚠️  Please restart your backend server for changes to take effect.\n');
} else {
  console.log('⚠️  .env file not found. Please manually add these keys to your .env file.\n');
}

console.log('=== End of VAPID Keys ===\n');

