# 🐛 Bug Squasher

بازی رفلکسی HTML5/Canvas که در قالب اپلیکیشن اندروید (از طریق Capacitor) منتشر شده. بازیکن در نقش یک برنامه‌نویس، باگ‌های کد رو "له" می‌کنه و امتیاز جمع می‌کنه؛ امتیازها در یک جدول امتیازات مشترک (آنلاین) بین همهٔ بازیکن‌ها ثبت و مقایسه می‌شه.

## 🎮 معرفی پروژه

- **پلتفرم:** اندروید (منتشرشده برای کافه‌بازار)
- **موتور بازی:** HTML5 Canvas + JavaScript خالص (بدون فریم‌ورک)
- **بسته‌بندی اپ:** [Capacitor](https://capacitorjs.com/) — انتخاب‌شده به‌جای TWA/Voltbuilder به‌خاطر حفظ haptics، کارکرد آفلاین، و کنترل کامل روی keystore
- **جدول امتیازات:** [Supabase](https://supabase.com/) (Postgres + Auth + RLS)

## 🛠️ تکنولوژی‌ها

| بخش | تکنولوژی |
|---|---|
| رابط کاربری بازی | HTML5, CSS, JavaScript (Canvas API) |
| بسته‌بندی اندروید | Capacitor + Android Studio (Gradle) |
| دیتابیس/بک‌اند | Supabase (PostgreSQL) |
| فیدبک لمسی | @capacitor/haptics |
| زبان اصلی رابط کاربری | فارسی (RTL) |

## 🏗️ ساختار پروژه

```
my-game/
├── www/                          # کد وب بازی (منبع اصلی)
│   └── index.html                # کل بازی: HTML + CSS + JS در یک فایل
├── android/                      # پروژهٔ اندروید (تولیدشده و مدیریت‌شده توسط Capacitor)
│   ├── app/
│   │   ├── build.gradle          # تنظیمات build و signing
│   │   ├── capacitor.build.gradle
│   │   └── bugsquasher-release.jks   # کلید امضا (⚠️ در .gitignore، هرگز public نمی‌شود)
│   └── keystore.properties       # رمزهای signing (⚠️ در .gitignore)
├── assets/
│   └── icon.png                  # لوگوی اصلی اپ (۱۰۲۴×۱۰۲۴) — منبع تولید آیکون‌ها
├── capacitor.config.json
└── package.json
```

## 🔒 امنیت جدول امتیازات (Leaderboard)

### مشکل کشف‌شده

نسخهٔ اولیه، امتیاز رو مستقیماً از سمت کلاینت (مرورگر/اپ) با `upsert` روی جدول Supabase می‌نوشت. چون کلید `anon` به‌ناچار داخل کد کلاینت قابل مشاهده‌ست، هرکسی می‌تونست با DevTools مستقیم به جدول بنویسه و امتیاز دلخواه ثبت کنه. این دقیقاً همون اتفاقی بود که افتاد: یک ردیف فیک با امتیاز ۹۹۹۹ در صدر جدول ثبت شد.

### راه‌حل پیاده‌شده

معماری نوشتن داده از حالت *کلاینت مستقیماً به جدول می‌نویسد* به حالت *کلاینت فقط یک تابع سرور را صدا می‌زند* تغییر کرد:

1. **Row Level Security (RLS):** روی جدول `leaderboard`، تمام Policyهای INSERT/UPDATE مستقیم حذف شدند. تنها Policy باقی‌مانده اجازهٔ **خواندن (SELECT)** عمومی است.
2. **تابع سرور (`submit_score`):** یک تابع PostgreSQL با ویژگی `SECURITY DEFINER` ساخته شد که:
   - نام و طول آن را اعتبارسنجی می‌کند
   - امتیاز ارسالی را در بازهٔ منطقی (حداکثر ۲۰۰۰) چک می‌کند
   - رکورد قبلی بازیکن را با `greatest()` مقایسه و در صورت لزوم به‌روزرسانی می‌کند
   - این تابع تنها راه نوشتن روی جدول است.
3. **کد کلاینت:** تابع `syncPlayerStats` در `index.html` از فراخوانی مستقیم `db.from('leaderboard').upsert(...)` به `db.rpc('submit_score', {...})` تغییر کرد.
4. **تست نفوذ:** با شبیه‌سازی نقش `anon` (`set role anon;`) تلاش برای نوشتن مستقیم روی جدول انجام شد و با خطای RLS (`new row violates row-level security policy`) رد شد — یعنی مسیر حمله‌ای که قبلاً استفاده شده بود، الان کاملاً بسته است.

## 🚀 راه‌اندازی و Build محلی

### پیش‌نیازها
- Node.js + npm
- Android Studio + Android SDK
- JDK 17

### مراحل

```powershell
# نصب وابستگی‌ها
npm install

# سینک کردن تغییرات www/ با پروژهٔ اندروید
npx cap sync android

# باز کردن پروژه در Android Studio
npx cap open android
```

### گرفتن نسخهٔ Release (از طریق ترمینال)

```powershell
cd android

# نسخهٔ AAB — برای آپلود روی کافه‌بازار
.\gradlew.bat bundleRelease

# نسخهٔ APK — برای نصب مستقیم و تست
.\gradlew.bat assembleRelease
```

خروجی‌ها:
- AAB: `android/app/build/outputs/bundle/release/app-release.aab`
- APK: `android/app/build/outputs/apk/release/app-release.apk`

### ساخت آیکون از روی لوگو

```powershell
npx capacitor-assets generate --android
npx cap sync android
```

## ⚠️ نکات امنیتی برای توسعهٔ آینده

- فایل‌های `*.jks` و `keystore.properties` **هرگز** نباید public/commit بشن (در `.gitignore` قرار دارند). گم‌شدن کلید امضا یعنی امکان انتشار آپدیت روی همون اپلیکیشن از بین می‌ره.
- هرگونه ستون یا جدول جدید در Supabase که کلاینت بهش دسترسی نوشتن داره، باید همین الگو (RLS محدود + تابع RPC اعتبارسنج) رو رعایت کنه؛ نوشتن مستقیم از کلاینت به‌طور پیش‌فرض ناامنه.

## 📌 وضعیت فعلی

- ✅ بازی کامل و قابل‌بازی
- ✅ جدول امتیازات آنلاین (امن‌شده)
- ✅ آیکون نهایی اپ
- ✅ نسخهٔ Release امضاشده (APK + AAB) آماده
- ⏳ انتشار نهایی روی کافه‌بازار
