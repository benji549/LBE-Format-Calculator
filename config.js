export const APP_CONFIG = {
  supabaseUrl: 'https://xochjezgskkvjbykiakd.supabase.co',
  supabasePublishableKey: 'sb_publishable_zTVkcDfN1VfMbVph7Yqp4g_ztkLxlQm',
  appName: 'LBE Format Calculator',
  maxComparedFormats: 4,
};

export function isConfigured() {
  return !APP_CONFIG.supabaseUrl.includes('YOUR_PROJECT_REF') &&
    !APP_CONFIG.supabasePublishableKey.includes('YOUR_SUPABASE');
}
