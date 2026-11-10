const SECRET_SCANNER = /gitguardian|gitleaks|trufflehog|secret[ -]?scan|detect-secrets/i;

export const isSecretScanner = check => SECRET_SCANNER.test(`${check?.name || ''} ${check?.app || ''}`);
