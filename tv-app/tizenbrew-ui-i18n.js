import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import resources from './i18nResources.js';

// Register the translation instance before any component calls useTranslation.
i18n.use(initReactI18next).init({
  lng: navigator.language.replace(/[-_].*/, ''),
  fallbackLng: 'en',
  resources,
  initImmediate: false,
  debug: true,
  interpolation: { escapeValue: false },
});
i18n.addResourceBundle('en', 'translation', {
  diagnostics: {
    title: 'Service diagnostics',
    controlsTitle: 'Service controls',
    manualStart: 'Press Restart service to start the service',
    check: 'Check service',
    restart: 'Restart service',
    noReply: 'No reply yet',
    lastReply: 'Last reply {{seconds}}s ago',
    liveLogs: 'Live service logs',
    empty: 'No service records received yet. Logs remain visible if the connection stops.',
  },
  moduleManager: {
    completeGitHubRef: 'Enter a version, tag, or commit after @, for example v1.4.0/hotstar.',
  },
}, true, true);

try {
  tizen.systeminfo.getPropertyValue('LOCALE', locale => {
    if (!locale || typeof locale.language !== 'string') {
      console.error('[TizenBrew UI] Locale response has no language');
      return;
    }
    i18n.changeLanguage(locale.language.replace(/[-_].*/, '')).catch(error => {
      console.error('[TizenBrew UI] Locale change failed: ' + error.message);
    });
  }, error => {
    console.warn('[TizenBrew UI] TV locale unavailable; using browser language: ' + error.message);
  });
} catch (error) {
  console.warn('[TizenBrew UI] TV locale lookup unavailable; using browser language: ' + error.message);
}

export default i18n;
