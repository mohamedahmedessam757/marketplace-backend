export enum OtpPurpose {
    REGISTER = 'REGISTER',
    LOGIN = 'LOGIN',
    RECOVERY_STEP1 = 'RECOVERY_STEP1',
    RECOVERY_PHONE = 'RECOVERY_PHONE',
}

export type OtpChannel = 'email' | 'whatsapp';

export const OTP_EXPIRY_MINUTES = 10;
export const OTP_MAX_VERIFY_ATTEMPTS = 5;
export const OTP_MAX_ISSUE_PER_WINDOW = 5;
export const OTP_ISSUE_WINDOW_MINUTES = 15;

/** Dev fallback when delivery channels are disabled — set OTP_DEV_BYPASS=false before go-live */
export const OTP_DEV_BYPASS_CODE = '123456';
