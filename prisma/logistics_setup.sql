-- SQL Migration: Comprehensive Platform Logistics & Financial Overhaul (v2026.1)
-- This script initializes the system with dynamic shipping rules and financial settings.
-- Run this in Supabase SQL Editor.

-- 1. Create Admin Activity Logs Table (Security Layer)
CREATE TABLE IF NOT EXISTS admin_activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES auth.users(id),
    email TEXT,
    action TEXT,
    ip_address TEXT,
    user_agent TEXT,
    device_type TEXT,
    browser TEXT,
    location TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Platform Settings Table (Ensure Existence)
CREATE TABLE IF NOT EXISTS "platform_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "setting_key" TEXT NOT NULL,
    "setting_value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_settings_setting_key_key" UNIQUE ("setting_key")
);

-- 3. Insert/Update Dynamic System Configuration
-- Merging General, Financial, Content, and the NEW Dynamic Logistics System
INSERT INTO "platform_settings" ("setting_key", "setting_value", "updated_at")
VALUES (
    'system_config',
    '{
        "general": {
            "platformName": "e-tashleh",
            "contactEmail": "cs@e-tashleh.net",
            "supportPhone": "0525700525",
            "enablePreferencesStep": true
        },
        "financial": {
            "commissionRate": 25,
            "minCommission": 100,
            "currency": "AED"
        },
        "logistics": {
            "shipmentTypes": [
                {
                    "id": "standard",
                    "nameAr": "شحن قياسي (قطع غيار عادية)",
                    "nameEn": "Standard Shipping (Normal Parts)",
                    "basePrice": 60,
                    "isWeightBound": true,
                    "weightBrackets": [
                        { "id": "1", "minWeight": 0, "maxWeight": 5, "price": 0 },
                        { "id": "2", "minWeight": 5.1, "maxWeight": 10, "price": 40 },
                        { "id": "3", "minWeight": 10.1, "maxWeight": 20, "price": 90 },
                        { "id": "4", "minWeight": 20.1, "maxWeight": 50, "price": 150 }
                    ]
                },
                {
                    "id": "engine",
                    "nameAr": "شحن ماكينة (محرك)",
                    "nameEn": "Engine Shipping",
                    "basePrice": 450,
                    "isWeightBound": false,
                    "weightBrackets": []
                },
                {
                    "id": "gearbox",
                    "nameAr": "شحن جيربوكس",
                    "nameEn": "Gearbox Shipping",
                    "basePrice": 350,
                    "isWeightBound": false,
                    "weightBrackets": []
                }
            ]
        },
        "content": {
            "vendorContract": {
                "contentAr": "",
                "contentEn": "",
                "firstPartyConfig": {}
            },
            "privacyPolicy": "System Default Policy",
            "invoiceFooter": "ELLIPP FZ LLC - Dubai, UAE"
        }
    }'::JSONB,
    NOW()
)
ON CONFLICT ("setting_key") 
DO UPDATE SET 
    "setting_value" = EXCLUDED."setting_value",
    "updated_at" = NOW();

-- 4. Insert/Update System Status (Maintenance & Service Monitoring)
INSERT INTO "platform_settings" ("setting_key", "setting_value", "updated_at")
VALUES (
    'system_status', 
    '{
        "maintenanceMode": false,
        "endTime": null,
        "maintenanceMsgAr": "النظام حالياً في وضع الصيانة لترقية الخوادم وتحسين الأداء لخدمتكم بشكل أفضل.",
        "maintenanceMsgEn": "System is currently under maintenance for server upgrades and performance optimization.",
        "statusMessageAr": "النظام يعمل بشكل طبيعي",
        "statusMessageEn": "System is operating normally"
    }'::JSONB,
    NOW()
)
ON CONFLICT ("setting_key") DO UPDATE 
SET "setting_value" = EXCLUDED."setting_value",
    "updated_at" = NOW();

-- 5. Ensure Withdrawal Limits exist
INSERT INTO "platform_settings" ("setting_key", "setting_value", "updated_at")
VALUES (
    'withdrawal_limits', 
    '{"min": 100, "max": 10000}'::JSONB,
    NOW()
)
ON CONFLICT ("setting_key") DO NOTHING;
