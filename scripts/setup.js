const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const envPath = path.join(__dirname, '..', '.env');

async function main() {
  if (fs.existsSync(envPath)) {
    throw new Error('.env sudah ada. Hapus atau pindahkan file tersebut jika ingin membuat kredensial baru.');
  }

  const username = 'admin';
  const password = crypto.randomBytes(18).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = await scrypt(password, salt, 64);
  const sessionSecret = crypto.randomBytes(48).toString('base64url');
  const env = [
    'PORT=3000',
    'NODE_ENV=development',
    `ADMIN_USERNAME=${username}`,
    `ADMIN_PASSWORD_HASH=scrypt$${salt}$${passwordHash.toString('hex')}`,
    `ADMIN_SESSION_SECRET=${sessionSecret}`,
    'MAX_GLB_MB=200',
    'PUBLIC_BASE_URL=http://localhost:3000',
    'AI_BASE_URL=',
    'AI_API_KEY=',
    'AI_MODEL='
  ].join('\n') + '\n';

  fs.writeFileSync(envPath, env, { flag: 'wx', mode: 0o600 });
  console.log('File .env dibuat. Simpan kredensial admin berikut di tempat aman:');
  console.log(`Nama pengguna: ${username}`);
  console.log(`Kata sandi: ${password}`);
  console.log('Kata sandi tidak dapat ditampilkan kembali. Untuk menggantinya, cadangkan lalu hapus .env dan jalankan npm run setup lagi.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
