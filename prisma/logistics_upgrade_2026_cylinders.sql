-- SQL Surgical Update: Logistics Configuration Upgrade (v2026.4)
-- Purpose: Implement cylinder-based pricing for engines and disable weight requirements for heavy parts.

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
                "hasCylinders": true,
                "cylinderRates": [
                    { "cylinders": 4, "price": 450 },
                    { "cylinders": 6, "price": 650 },
                    { "cylinders": 8, "price": 850 }
                ]
            },
            {
                "id": "gearbox",
                "nameAr": "شحن جيربوكس",
                "nameEn": "Gearbox Shipping",
                "basePrice": 350,
                "isWeightBound": false
            }
        ]
    }'::jsonb,
    true
),
"updated_at" = NOW()
WHERE "setting_key" = 'system_config';
