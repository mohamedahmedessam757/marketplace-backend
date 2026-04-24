-- SQL Surgical Update: Logistics Configuration Only (v2026.3)
-- This script ONLY updates the "logistics" key inside "system_config".
-- It preserves your existing "general", "financial", and "content" settings.

UPDATE "platform_settings"
SET "setting_value" = jsonb_set(
    COALESCE("setting_value", '{}'::jsonb),
    '{logistics}',
    '{
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
    }'::jsonb,
    true -- Create key if it doesn't exist
),
"updated_at" = NOW()
WHERE "setting_key" = 'system_config';
