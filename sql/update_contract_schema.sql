-- Add new columns to platform_contracts table
ALTER TABLE "platform_contracts"
RENAME COLUMN "title" TO "title_ar";

ALTER TABLE "platform_contracts"
RENAME COLUMN "content" TO "content_ar";

ALTER TABLE "platform_contracts" 
ADD COLUMN IF NOT EXISTS "title_en" VARCHAR(255) DEFAULT 'Partnership Agreement with ELLIPP FZ-LLC',
ADD COLUMN IF NOT EXISTS "content_en" TEXT DEFAULT '',
ADD COLUMN IF NOT EXISTS "first_party_config" JSONB DEFAULT '{"companyNameAr": "شركة إليب ش.م.ح-ذ.م.م", "companyNameEn": "ELLIPP FZ-LLC", "crNumber": "4036902", "licenseNumber": "45000927", "licenseExpiry": "19-6-2026", "headquartersAr": "إمارة رأس الخيمة بدولة الامارات العربية المتحدة", "headquartersEn": "Ras Al Khaimah, United Arab Emirates"}';

-- Add contract signature field to stores table (For merchants electronic signature name)
ALTER TABLE "stores"
ADD COLUMN IF NOT EXISTS "contract_signature" VARCHAR(255) DEFAULT '';

-- Update existing active contract with the new template texts

UPDATE "platform_contracts"
SET 
  "title_ar" = 'عقد استضافة متجر إلكتروني',
  "title_en" = 'E-Commerce Store Hosting Agreement',
  "first_party_config" = '{"companyNameAr": "شركة إليب ش.م.ح-ذ.م.م", "companyNameEn": "ELLIPP FZ-LLC", "crNumber": "4036902", "licenseNumber": "45000927", "licenseExpiry": "2026-06-19", "headquartersAr": "إمارة رأس الخيمة بدولة الامارات العربية المتحدة", "headquartersEn": "Ras Al Khaimah, United Arab Emirates"}',
  "content_ar" = 'عقد استضافة متجر إلكتروني

الطرف الأول: {{FIRST_PARTY_NAME_AR}} ،المالك للمنصة الالكترونية (e-tashleh) سجل تجاري {{FIRST_PARTY_CR}}، رخصة تجارية {{FIRST_PARTY_LICENSE}} والمنتهية بتاريخ {{FIRST_PARTY_EXPIRY}} ومقرها في {{FIRST_PARTY_HQ_AR}}.

الطرف الثاني: شركة {{CUSTOMER_COMPANY_NAME}}، ويمثلها مديرها الموقع {{CUSTOMER_NAME}}
سجل تجاري رقم {{CUSTOMER_CR}}، رخصة تجارية رقم {{CUSTOMER_LICENSE}} والمنتهية بتاريخ {{CUSTOMER_EXPIRY}}
ومقرها في امارة {{CUSTOMER_EMIRATE}} بدولة {{CUSTOMER_COUNTRY}}.

مقدمة:
نظرًا لرغبة الطرف الثاني في إنشاء متجر إلكتروني عبر منصة (e-tashleh) لبيع قطع غيار السيارات المستعملة، فقد اتفق الطرفان على ما يلي:

البند الأول: موضوع العقد
يقوم الطرف الأول بتوفير مساحة إلكترونية على منصته (e-tashleh) للطرف الثاني بهدف تشغيل متجر إلكتروني لبيع قطع غيار السيارات المستعملة، مع توفير الخدمات التالية:
- بوابة دفع إلكترونية.
- دعم فني للمتجر.
- خدمة شحن بالتعاون مع شركات شحن معتمدة.

البند الثاني: العمولات
يستحق الطرف الأول عمولة بنسبة مستقطعة من قيمة كل عملية بيع ناجحة تتم عبر المتجر (يتم تفصيلها اثناء إضافة المنتج).

البند الثالث: مدة العقد
مدة هذا العقد هي سنة ميلادية واحدة تبدأ من تاريخ التوقيع، قابلة للتجديد باتفاق الطرفين الكترونيا.

البند الرابع: التزامات الطرف الثاني (الشروط والأحكام)
- يجب على البائع/المتجر والعميل/المستخدم الموافقة على الشروط وسياسة الخصوصية وسياسة المدفوعات على موقعنا وسياسة الاستبدال والارجاع جميعها واستخدامك للموقع يعتبر موافقة منك على ذلك ولا يتحمل الموقع أي مسؤولية قانونية جراء عدم اطلاعكم عليها.
- في حال اكتمال عملية الدفع عبر موقعنا فلا يحق المتجر/البائع الغاء العملية او رفضها او تغيير شروطها.
- يوافق البائع/المتجر على تفويضنا بتسجيل حسابة البنكي في بوابة المدفوعات المعتمدة، وإقرار منه على إطلاعه وموافقته على ذلك.
- التواصل المعتمد لأي ملاحظات او بلاغات او مرسلات هو فقط الطرق المتاحة على أيقونة الموقع.
- في حال وجود نزاع بين الموقع والبائع/المتجر يكون التقاضي بدولة الامارات العربية المتحدة.
- يوافق ويقر المتجر/البائع بان الاتفاقية المعتمدة فقط هي الاتفاقية الالكترونية عبر التسجيل بالموقع والموافقة عليها.
- يقر ويوافق المتجر بتوصيل الطلبات مطابقة للفاتورة للشركة الشاحنة والاحتفاظ بالسجلات للحماية القانونية.
- حدود مسؤولية (الموقع): تعمل المنصة كوسيط تقني ولا تملك المنتجات، ويتحمل المتجر كامل المسؤولية للضمان وجودة السلع.

التوثيق عند تسليم الشحنات وتحمل المسؤولية:
يلتزم المتجر عند تسليم المنتجات لشركة الشحن بتوثيق صور وفيديو للحالة الظاهرية، وتسجيل ذلك داخل النظام حتى تنتقل المسؤولية لشركة الشحن. الفشل في ذلك يجعل المتجر يتحمل كامل المسؤولية جراء الأضرار.

شروط وسياسة الاستبدال والارجاع:
- يجب على العميل التواصل من خلال القنوات الرسمية خلال 24 ساعة من الاستلام للإرجاع أو التبديل. الدعم سيتدخل إن لم يتم حل النزاع خلال 3 أيام.
- العيوب والمشاكل التي يتسبب بها الشحن يتم تغطيتها من طرف الشحن إن وثقها العميل خلال 24 ساعة.

البند الخامس: الإلغاء وفسخ العقد
يحق لأي من الطرفين إنهاء العقد بإشعار كتابي قبل 30 يومًا، على أن تتم تصفية أي معاملات مالية قائمة قبل الإنهاء. يحق للطرف الأول إلغاء العقد فورًا في حال مخالفة الطرف الثاني للأنظمة والشروط.

البند السادس: السرية
يلتزم الطرفان بالحفاظ على سرية المعلومات والبيانات المتبادلة خلال فترة التعاقد وبعد انتهائها.

البند السابع: النزاعات
تُحل النزاعات بين الطرفين وديًا، وإن تعذر ذلك، تكون الجهة القضائية المختصة في الامارات العربية المتحدة هي المرجع للفصل.

تمت الموافقة من: {{CUSTOMER_COMPANY_NAME}}
بتاريخ: {{CURRENT_DATE}}
الاسم المعتمد للتوقيع الإلكتروني: {{CUSTOMER_NAME}}
البريد الإلكتروني: {{CUSTOMER_EMAIL}}
رقم الجوال: {{CUSTOMER_PHONE}}
العنوان: {{CUSTOMER_ADDRESS}}
',
  "content_en" = 'E-Commerce Store Hosting Agreement

First Party: {{FIRST_PARTY_NAME_EN}} (Website/Platform Owner e-tashleh), represented by its authorized manager.
Commercial Registration Number {{FIRST_PARTY_CR}}, Commercial License {{FIRST_PARTY_LICENSE}}, Trade license expiry date {{FIRST_PARTY_EXPIRY}}, Based in {{FIRST_PARTY_HQ_EN}}.

Second Party: {{CUSTOMER_COMPANY_NAME}}, represented by its authorized manager {{CUSTOMER_NAME}}.
Commercial Registration Number {{CUSTOMER_CR}}, Commercial License {{CUSTOMER_LICENSE}}, Trade license expiry date {{CUSTOMER_EXPIRY}}, Based in {{CUSTOMER_EMIRATE}}, {{CUSTOMER_COUNTRY}}.

Preamble:
Whereas the Second Party wishes to establish an online store through the e-tashleh platform to sell used auto spare parts, the parties have agreed to the following terms:

Clause One: Subject of the Agreement
The First Party shall provide the Second Party with digital space on its platform (e-tashleh) to operate an online store for selling used auto spare parts. The First Party shall also provide:
- An integrated electronic payment gateway.
- Technical support for the store.
- Shipping services via approved logistics providers.

Clause Two: Commission
The First Party is entitled to a deduced commission on every successful sale made through the online store (detailed upon product add).

Clause Three: Contract Duration
This contract shall be valid for one calendar year from the date of signing. It may be renewed upon mutual electronic agreement by both parties.

Clause Four: Obligations of the Second Party (Terms & Conditions)
- The Seller/Store and the Customer/User must agree to the Terms and Conditions, Privacy Policy, Payment Policy, and Return & Exchange Policy on our website.
- Once the payment process is completed through our website, the Seller/Store is not entitled to cancel the transaction, refuse it, or change its terms.
- The Seller/Store agrees to authorize us to register their bank account on the approved payment gateway on the website to receive the sales proceeds directly.
- The only official communication channel for any notes, reports, or correspondence is through the options available on the website icon.
- In case of a dispute between the website and the Seller/Store, litigation shall take place in the United Arab Emirates.
- The Seller/Store agrees and acknowledges to retain the sold product paid through our website, delivery to shipping safely, and keep proper documentation.
- Website Liability Limits: The platform acts as a technical intermediary connecting customers to stores and does not own the products offered. The seller bears full responsibility.

Documentation upon Delivery and Liability:
The store must upload clear pictures and videos into the system upon handing the item to the delivery partner. Failure to properly document transfers the liability fully to the store if any damage was detected.

Terms and Conditions for Exchange and Return Policy:
- In case of dispute, return, or request, the customer must contact through official channels within 24 hours of receipt. If unresolved within 3 days, it escalates to the management.
- For returns/cancellations due to personal preference, the customer bears returning shipping cost plus 2% invoice fee.
- If it is due to defect, the store bears round-trip shipping.

Clause Five: Termination
Either party has the right to terminate the contract by providing a written notice 30 days in advance, provided that all outstanding financial transactions are settled. The First party reserves the right to terminate immediately for rule violations.

Clause Six: Confidentiality
Both parties agree to maintain the confidentiality of exchanged information during and after the term of the agreement.

Clause Seven: Dispute Resolution
Any dispute arising from this agreement shall be resolved amicably; if unresolved, jurisdiction shall be with the competent courts in the United Arab Emirates.

Accepted By: {{CUSTOMER_COMPANY_NAME}}
Date: {{CURRENT_DATE}}
Authorized Name for Electronic Signature: {{CUSTOMER_NAME}}
Email: {{CUSTOMER_EMAIL}}
Mobile Number: {{CUSTOMER_PHONE}}
Address: {{CUSTOMER_ADDRESS}}
'
WHERE "is_active" = true;
