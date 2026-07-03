// sync-mobile.js
// Copia assets opcionales al directorio mobile/ para el APK de Capacitor.
// mobile/index.html es el archivo principal de la app móvil y NO se sobreescribe aquí.
// Si necesitas copiar otros recursos (imágenes, assets, etc.) agrégalos abajo.

const fs   = require('fs');
const path = require('path');

const rootDir   = path.join(__dirname, '..');
const mobileDir = path.join(rootDir, 'mobile');

if (!fs.existsSync(mobileDir)) {
  fs.mkdirSync(mobileDir, { recursive: true });
}

// Verificar que la app mobile existe
const mobileApp = path.join(mobileDir, 'index.html');
if (!fs.existsSync(mobileApp)) {
  console.error('ERROR: mobile/index.html no encontrado. La app mobile debe existir antes de sincronizar.');
  process.exit(1);
}

console.log('✅ mobile/index.html encontrado — OK');
console.log('✅ Sincronización completada. Usa "npx cap sync android" para actualizar el APK.');
