# Client Mobile App — Native Setup Guide

The TypeScript source layer is complete. To build and run on a device or emulator, the following native setup is required.

## Requirements

- **Android:** Android Studio + Android SDK (API 26+), or a physical Android device (Android 8.0+)
- **iOS:** macOS + Xcode 15+ (iOS 16+ simulator or physical device)
- Node.js 18+, JDK 17+

## Install JS dependencies

```bash
cd client-mobile
npm install
```

## Android setup

1. Install Android Studio and Android SDK (API 26+)
2. Set `ANDROID_HOME` environment variable
3. Run on emulator or device:
```bash
npm run android
```

## iOS setup

1. Install pods:
```bash
cd ios && pod install && cd ..
```
2. Run:
```bash
npm run ios
```

## Firebase setup

1. Create two Firebase projects: one for staging, one for production
2. Download `google-services.json` (Android) → place in `android/app/`
3. Download `GoogleService-Info.plist` (iOS) → place in `ios/AIScheduler/`
4. Enable Cloud Messaging in each Firebase project

## Universal links (deep links)

- **iOS:** Add `applinks:app.[domain]` to the `Associated Domains` entitlement in Xcode
- **Android:** Add the intent filter in `android/app/src/main/AndroidManifest.xml`:
  ```xml
  <intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="app.myscheduler.com" android:pathPrefix="/redeem" />
  </intent-filter>
  ```

## Minimum targets

- **iOS:** Set minimum deployment target to **iOS 16** in Xcode → General → Minimum Deployments
- **Android:** Set `minSdkVersion 26` in `android/app/build.gradle`
