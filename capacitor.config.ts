import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bobo.checklist',
  appName: 'Checklist Shelly',
  webDir: 'mobile',
  server: {
    androidScheme: 'http'
  },
  plugins: {
    CapacitorHttp: {
      enabled: true
    }
  }
};

export default config;
