// src/utils/email-i18n.ts
// US-I18N-1.2 SC4: Localised subjects and greeting lines for transactional emails.
// HTML bodies remain English in Phase 1 — only subjects/greetings are localised here.
// Fallback to English if no translation exists for the requested locale.

export type SupportedLocale = 'en' | 'fr' | 'de' | 'es' | 'pt';

const EMAIL_STRINGS: Record<SupportedLocale, {
  magic_link_subject: string;
  magic_link_greeting: (name: string) => string;
  welcome_subject: (name: string) => string;
  billing_confirm_subject: string;
  cancellation_subject: string;
  deletion_subject: string;
  trial_expiry_subject: string;
}> = {
  en: {
    magic_link_subject: 'Your Aura-Assist login link',
    magic_link_greeting: (name) => `Hi ${name},`,
    welcome_subject: (name) => `Welcome to Aura-Assist, ${name}! 🎉`,
    billing_confirm_subject: 'Your Aura-Assist subscription is confirmed',
    cancellation_subject: 'Your Aura-Assist subscription has been cancelled',
    deletion_subject: 'Confirm your account deletion — Aura-Assist',
    trial_expiry_subject: 'Your Aura-Assist trial is ending soon',
  },
  fr: {
    magic_link_subject: 'Votre lien de connexion Aura-Assist',
    magic_link_greeting: (name) => `Bonjour ${name},`,
    welcome_subject: (name) => `Bienvenue sur Aura-Assist, ${name} ! 🎉`,
    billing_confirm_subject: 'Votre abonnement Aura-Assist est confirmé',
    cancellation_subject: 'Votre abonnement Aura-Assist a été annulé',
    deletion_subject: 'Confirmez la suppression de votre compte — Aura-Assist',
    trial_expiry_subject: 'Votre essai Aura-Assist se termine bientôt',
  },
  de: {
    magic_link_subject: 'Ihr Aura-Assist-Anmeldelink',
    magic_link_greeting: (name) => `Hallo ${name},`,
    welcome_subject: (name) => `Willkommen bei Aura-Assist, ${name}! 🎉`,
    billing_confirm_subject: 'Ihr Aura-Assist-Abonnement wurde bestätigt',
    cancellation_subject: 'Ihr Aura-Assist-Abonnement wurde gekündigt',
    deletion_subject: 'Bestätigen Sie die Löschung Ihres Kontos — Aura-Assist',
    trial_expiry_subject: 'Ihre Aura-Assist-Testphase endet bald',
  },
  es: {
    magic_link_subject: 'Tu enlace de acceso a Aura-Assist',
    magic_link_greeting: (name) => `Hola ${name},`,
    welcome_subject: (name) => `¡Bienvenido a Aura-Assist, ${name}! 🎉`,
    billing_confirm_subject: 'Tu suscripción a Aura-Assist está confirmada',
    cancellation_subject: 'Tu suscripción a Aura-Assist ha sido cancelada',
    deletion_subject: 'Confirma la eliminación de tu cuenta — Aura-Assist',
    trial_expiry_subject: 'Tu prueba de Aura-Assist está por terminar',
  },
  pt: {
    magic_link_subject: 'O seu link de acesso ao Aura-Assist',
    magic_link_greeting: (name) => `Olá ${name},`,
    welcome_subject: (name) => `Bem-vindo ao Aura-Assist, ${name}! 🎉`,
    billing_confirm_subject: 'A sua subscrição Aura-Assist foi confirmada',
    cancellation_subject: 'A sua subscrição Aura-Assist foi cancelada',
    deletion_subject: 'Confirme a eliminação da sua conta — Aura-Assist',
    trial_expiry_subject: 'O seu período de teste Aura-Assist está prestes a terminar',
  },
};

export function getEmailStrings(lang: string | null | undefined) {
  const locale = (lang && lang in EMAIL_STRINGS) ? lang as SupportedLocale : 'en';
  return EMAIL_STRINGS[locale];
}
