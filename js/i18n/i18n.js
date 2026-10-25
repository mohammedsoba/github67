// ============================================================
// i18n.js — Full Internationalization System
// Supports: English (en), Arabic (ar) with full RTL
// ============================================================

(function () {
  'use strict';

  var translations = {
    en: {
      // ── Top bar ──────────────────────────────────────────
      undo: 'Undo',
      newPhoto: 'New Photo',
      save: 'Save',

      // ── Upload box ───────────────────────────────────────
      // ── Launch splash ────────────────────────────────────
      splashTagline: 'AI Photo Studio',

      tapToSelect: 'Tap to choose a photo',
      supportsFormats: 'JPG, PNG or WebP',

      // ── Loading ──────────────────────────────────────────
      processing: 'Processing…',

      // ── Compare ──────────────────────────────────────────
      original: 'Original',

      // ── Crop actions ─────────────────────────────────────
      apply: 'Apply',
      cancel: 'Cancel',
      cropHint: 'Choose “Free”, then drag on the photo to crop',
      free: 'Free',

      // ── Edit sub-tabs ────────────────────────────────────
      filters: 'Filters',
      light: 'Light',
      color: 'Color',
      mix: 'Mix',
      curves: 'Curves',
      detail: 'Detail',
      crop: 'Crop',

      // ── Tools sub-tabs ───────────────────────────────────
      eraser: 'Eraser',
      aiMask: 'AI Mask',
      portrait: 'Portrait',
      enhanceFace: 'Enhance Face',
      autoEnhance: 'Auto Enhance',

      // ── Nav tabs ─────────────────────────────────────────
      navEdit: 'Edit',
      navTools: 'Tools',
      navFrame: 'Frame',
      navSettings: 'Settings',

      // ── Light sliders ────────────────────────────────────
      brightness: 'Brightness',
      contrast: 'Contrast',
      exposure: 'Exposure',
      shadows: 'Shadows',
      whites: 'Whites',
      blacks: 'Blacks',

      // ── Color sliders ────────────────────────────────────
      saturation: 'Saturation',
      vibrance: 'Vibrance',
      warmth: 'Warmth',
      tint: 'Tint',

      // ── Mix sliders ──────────────────────────────────────
      hue: 'Hue',
      sat: 'Sat',
      luma: 'Luma',

      // ── Curves ───────────────────────────────────────────
      curvesHint: 'Drag points to adjust tones',
      curveRed: 'Red',
      curveGreen: 'Green',
      curveBlue: 'Blue',
      curveReset: 'Reset',
      curveResetAria: 'Reset this curve',
      segOffline: 'You’re offline. The AI cut-out model isn’t on this device yet — connect once to download it, then try again.',
      segLoadTimeout: 'The AI model is taking too long to download. Check your connection and try again.',
      segLoadFailed: 'Couldn’t load the AI model. Check your connection and try again.',
      segTimeout: 'The AI analysis took too long. Please try again.',
      segFailed: 'Couldn’t analyze the photo. Please try again.',

      // ── Detail sliders ───────────────────────────────────
      sharpness: 'Sharpness',
      clarity: 'Clarity',
      vignette: 'Vignette',
      grain: 'Grain',

      // ── Portrait panel ───────────────────────────────────
      portraitMode: 'Portrait Mode',
      portraitDesc: 'Drag a slider to blur the background or smooth skin, or tap Set Focus and then your subject.',
      blurAmount: 'Blur Amount',
      skinSmoothing: 'Skin Smoothing',
      setFocus: 'Set Focus',
      saveResult: 'Save Result',
      reapply: 'Reapply',
      portraitFailed: 'Couldn’t create the portrait. Please try again.',
      tryAgain: 'Try again',
      portraitBusyRetry: 'Server is busy — retrying…',
      errPortraitBusy: 'Portrait is busy right now. Please try again in a few seconds.',

      // ── Enhance Face panel ───────────────────────────────
      enhanceFaceTitle: 'Enhance Face',
      enhanceFaceDesc: 'Refine skin, detail, tone and sharpness — all on your device.',

      // ── Auto Enhance panel ───────────────────────────────
      autoEnhanceTitle: 'Auto Enhance',
      autoEnhanceDesc: 'Analyze your photo and fine-tune brightness, contrast, color and sharpness in one tap.',

      // ── AI Mask ──────────────────────────────────────────
      aiMaskTitle: 'AI Mask',
      aiMaskHint: 'Edit one region at a time',
      aiMaskAutoBtn: 'Auto-Enhance All Regions',
      sky: 'Sky',
      person: 'Person',
      background: 'Background',
      reset: 'Reset',

      // ── Frame panel ──────────────────────────────────────
      all: 'All',
      minimal: 'Minimal',
      polaroid: 'Polaroid',
      film: 'Film',
      neon: 'Neon',
      luxury: 'Luxury',
      gradient: 'Gradient',
      social: 'Social',
      rounded: 'Rounded',
      vintage: 'Vintage',
      clean: 'Clean',
      thickness: 'Thickness',
      radius: 'Radius',
      shadow: 'Shadow',
      padding: 'Padding',
      frameColor: 'Color',
      off: 'Off',
      resetFrame: '↺ Reset',

      // ── Magic Eraser ─────────────────────────────────────
      magicEraser: 'Magic Eraser',
      undo2: 'Undo',
      redo: 'Redo',
      clear: 'Clear',
      removeWithAI: 'Remove with AI',
      before: 'Before',
      downloadHD: 'Download HD',
      brushSize: 'Brush Size',
      holdToCompare: 'Hold to Compare',
      removingObject: 'Removing object…',
      processingPortrait: 'Processing portrait…',
      stagePreparing: 'Preparing…',
      stageWaiting: 'Waiting for the AI server…',
      stageReceiving: 'Receiving the result…',
      stageBlending: 'Blending the result into your photo…',
      stageApplying: 'Finishing up…',
      etaUsually: 'Usually about {s} s',

      // ── Premium modal ────────────────────────────────────
      premiumTitle: 'YoFilter',
      premiumSubtitle: 'Unlock professional editing tools',
      premiumPrice: '$4.99',
      premiumPricePeriod: '/month',
      premiumF1: 'Unlimited high-quality export',
      premiumF2: 'Advanced subject isolation',
      premiumF3: 'All premium filters and effects',
      premiumF4: 'Batch editing and cloud sync',
      premiumF5: 'No watermarks',
      upgradeNow: 'Upgrade',
      later: 'Not Now',

      // ── Export modal ─────────────────────────────────────
      exportTitle: 'Export Image',
      exportSubtitle: 'Choose a format. Photos export at editing resolution (up to 2560 px on the long edge).',
      lowQuality: 'Small file (JPEG 60%)',
      lowQualityTag: 'Smallest file · some detail lost',
      normalQuality: 'Standard (JPEG 92%)',
      normalQualityTag: 'Balanced size and quality',
      ultraQuality: 'Lossless (PNG)',
      ultraQualityTag: 'No quality loss · largest file',

      // ── Settings ─────────────────────────────────────────
      back: 'Back',
      settingsTitle: 'Settings',
      language: 'Language',
      aboutApp: 'About YoFilter',

      // ── About App ────────────────────────────────────────
      aboutTitle: 'About YoFilter',
      appName: 'YoFilter',
      appVersion: 'Version 1.0.0',
      appDescription: 'YoFilter is an AI-powered photo studio with professional-grade tools, right in your browser. Edit, enhance and transform your photos with ease.',
      keyFeatures: 'Key Features',
      feature1: 'AI background removal and Portrait mode',
      feature2: 'Magic Eraser to remove unwanted objects',
      feature3: 'Advanced filters, presets and color grading',
      feature4: 'Smart auto-enhance',
      feature5: 'Frame studio with 50+ professional frames',
      feature6: 'Most tools work offline. Magic Eraser and Portrait need the AI server.',
      developer: 'Developer',
      developerName: 'Yassen Mohammed',
      contactEmail: 'Contact Email',
      contactEmailVal: 'mmyasomm@gmail.com',
      privacyPolicy: 'Privacy Policy',
      privacyPolicyText: 'Your privacy matters. Filters, presets, curves, color mix, crop, frames, background removal, AI masks and face enhance are processed on your device. Two features send the photo you are editing to the YoFilter AI server over the internet: Magic Eraser (the photo and the area you painted) and Portrait (the photo and your blur / skin settings). The server uses them only to create the result and returns it; the server software keeps them in memory and does not save your photos to disk. It may log technical details such as time, file size and IP address, never the photo itself. Background removal and AI masks run on your device but download their AI model from a public CDN the first time, unless the model is bundled with the app. We do not ask for an account or collect personal data. Exported photos are saved only on your device.',
      termsOfService: 'Terms of Service',
      termsText: 'By using YoFilter, you agree to use the app in accordance with applicable laws. You keep full ownership of every image you edit. The app is provided “as is”, without warranty of any kind.',
      openSourceLicenses: 'Open Source Licenses',
      licensesText: 'YoFilter uses the following open-source technologies: MediaPipe (Apache 2.0) — AI segmentation models. Google Fonts (SIL Open Font License) — Inter, Tajawal and Noto Sans Arabic typefaces.',

      // ── Toast / loading messages ─────────────────────────
      toastLoadImage: 'Open a photo first',
      toastAnalyzing: 'Analyzing photo…',
      toastOptimalSettings: 'Finding the best adjustments…',
      toastComingSoon: 'Premium is coming soon',
      toastBgFailed: 'Couldn’t remove the background. Please try again.',
      toastOpenPhoto: 'Open a photo first',
      loadingRemoving: 'Removing background…',
      loadingLocalAI: 'Loading the AI model…',
      loadingPreparing: 'Preparing subject detection…',
      loadingIsolating: 'Isolating the subject…',
      loadingTransparent: 'Creating transparent PNG…',

      // ── V22: toasts, ARIA/alt, export, watermark ─────────
      loadingImage: 'Loading photo…',
      toastImageLoadFailed: 'Couldn’t open this photo. Try a different file.',
      toastFileReadFailed: 'Couldn’t read this file. Try another photo.',
      toastBackToExit: 'Press back again to exit',
      toastBackBusy: 'Still working — press back again to exit anyway',
      toastLoadFailed: 'Couldn’t load the photo. Please try again.',
      toastSyncFailed: 'Your result is ready, but it couldn’t be added to the editor. Please try again.',
      swipeNothingToUndo: 'Nothing to undo',
      swipeRedoSoon: 'Redo isn’t available yet',
      stateOn: 'On',
      toastNoImageExport: 'Open a photo to export',
      toastExportBusy: 'Already exporting — just a moment',
      exportingLow: 'Exporting JPEG 60%…',
      exportingLowSub: 'Smallest file size',
      exportingNormal: 'Exporting JPEG 92%…',
      exportingNormalSub: 'Balanced size and quality',
      exportingUltra: 'Exporting lossless PNG…',
      exportingUltraSub: 'No quality loss · large file',
      exportLabelPng: 'PNG lossless',
      exportLabelJpeg: 'JPEG {q}%',
      toastExportShared: 'Shared ({label} · {size} MB)',
      toastExportSaved: 'Saved ({label} · {size} MB)',
      toastExportFailed: 'Couldn’t export the photo. Please try again.',
      toastSavedName: 'Saved as {name}',
      toastSaveFailed: 'Couldn’t save the photo. Check your available storage and try again.',
      watermarkLabel: 'Add watermark on export',
      watermarkHint: 'Adds a small “yf” mark to the bottom corner of exported photos.',
      loadingFilter: 'Applying filter…',
      loadingFilterSub: 'Just a moment',
      maskReady: 'Ready — adjust the sliders, then tap Apply',
      maskPreparing: 'Detecting regions',
      maskAnalyzeFailed: 'Couldn’t analyze the photo. Please try again.',
      maskPickRegion: 'Choose a region first: Sky, Person or Background',
      maskAdjustFirst: 'Adjust a slider first',
      maskApplyingTitle: 'Applying AI Mask…',
      maskRegionSub: 'Region: {region}',
      maskApplyingTo: 'Applying to {region}…',
      maskBlending: 'Blending…',
      maskFinalizing: 'Finishing up…',
      maskStack: 'Applied — choose another region to keep refining',
      maskFailed: 'Couldn’t apply the mask. Please try again.',
      maskAutoTitle: 'Enhancing…',
      maskAutoSub: 'Detecting regions',
      maskAutoStatus: 'Enhancing sky, person and background…',
      maskAnalyzingTones: 'Analyzing tones…',
      maskBlendingAll: 'Blending sky, background and person…',
      maskEnhancedHint: 'Enhanced — choose a region to fine-tune',
      maskAutoFailed: 'Couldn’t enhance the photo. Please try again.',
      loadingEnhancing: 'Enhancing portrait…',
      loadingEnhancingSub: 'Enhancing on your device',
      loadingDetectSkin: 'Detecting skin and face tones…',
      loadingSharpness: 'Refining sharpness…',
      toastEnhanceFailed: 'Couldn’t enhance the portrait. Please try again.',
      toastNoResultDownload: 'Nothing to download yet',
      toastPortraitShared: 'Shared ({size} MB)',
      toastPortraitSaved: 'Saved ({size} MB)',
      toastDownloadFailed: 'Couldn’t download the photo. Please try again.',
      toastRestoreFailed: 'Couldn’t restore the original photo.',
      errPortraitModel: 'Portrait isn’t available right now. Please try again later.',
      edgePreparing: 'Setting up AI features (one-time download)…',
      edgeVerifying: 'Verifying download…',
      edgeStarting: 'Starting on-device AI…',
      edgeReady: 'On-device AI is ready',
      edgeMb: '{done} / {total} MB',
      edgeRetry: 'Retry',
      edgeErrOffline: 'You’re offline. Connect once to download the AI model, then try again.',
      edgeErrNetwork: 'The download was interrupted. Check your connection and try again.',
      edgeErrHttp: 'The AI model server is unavailable right now ({status}). Please try again later.',
      edgeErrCorrupt: 'The downloaded model is damaged. Please try again.',
      edgeErrQuota: 'Not enough storage for the AI model. Free up about 100 MB and try again.',
      edgeErrRuntime: 'On-device AI couldn’t start, so the server will be used instead.',
      edgeErrGeneric: 'Couldn’t set up the AI features. Please try again.',
      errImageTooLarge: 'This photo is too large (25 MB max)',
      errServerStatus: 'Something went wrong on the server ({status}). Please try again.',
      errNotImage: 'The server didn’t return a photo. Please try again.',
      errProcessedLoad: 'Couldn’t load the processed photo.',
      toastNothingToErase: 'Paint over the object you want to remove first',
      toastSelectionTooLarge: 'Selection too large. Max width is {max}px.',
      toastPngShared: 'Shared (PNG · {size} MB)',
      toastPngSaved: 'Saved (PNG · {size} MB)',
      toastCropTooSmall: 'The crop area is too small. Enlarge it and try again.',
      toastCropNoArea: 'Select an area to crop first',
      toastCropFailed: 'Couldn’t crop the photo. Please try again.',
      announceCropSize: 'Crop area {w} by {h} pixels',
      frameColorUnavailable: 'Custom color isn’t available for this frame',
      apiUnreachable: 'Can’t reach the AI server. Check your connection and try again.',
      apiGeneric: 'Something went wrong. Please try again.',
      apiTimeout: 'The server took too long to respond. Try a smaller area, or try again.',
      apiTooLarge: 'This photo is too large for the server (25 MB max).',
      apiTooMany: 'Too many requests. Please wait a moment and try again.',
      apiModelNotLoaded: 'The AI model isn’t ready on the server yet. Please try again shortly.',
      apiNotFound: 'The AI service isn’t available at this address.',
      apiRejected: 'The server couldn’t accept this request.',
      apiServerError: 'The server ran into a problem while processing the photo.',
      apiSeeLog: ' Please try again later.',
      apiStatus: 'Something went wrong on the server ({status}). Please try again.',
      apiNoBase: 'The AI server isn’t set up in this version of the app.',
      altMainImage: 'Photo being edited',
      altOriginalImage: 'Original photo, before edits',
      ariaHoldOriginal: 'Hold to see the original',
      ariaCurvesCanvas: 'Tone curve editor',
      ariaPortraitTools: 'Portrait tools',
      ariaClose: 'Close',
      ariaMainNav: 'Main navigation',
      ariaEditTools: 'Edit tools',
      ariaAiTools: 'AI tools',
      ariaFrameCats: 'Frame categories',
      ariaFrameGrid: 'Frames',
      ariaFilterGrid: 'Filters',
      ariaCropRatios: 'Crop aspect ratio',
      ariaMaskRegions: 'Region to adjust',
      ariaMixColors: 'Color to adjust',
      ariaCropBox: 'Crop area',
      ariaLoading: 'Working, please wait',
      announceShowingOriginal: 'Showing the original photo',
      announceShowingEdited: 'Showing the edited photo',
      mixRed: 'Red',
      mixOrange: 'Orange',
      mixYellow: 'Yellow',
      mixGreen: 'Green',
      mixAqua: 'Aqua',
      mixBlue: 'Blue',
      mixPurple: 'Purple',
      mixMagenta: 'Magenta',
    },

    ar: {
      // ── Top bar ──────────────────────────────────────────
      undo: 'تراجع',
      newPhoto: 'صورة جديدة',
      save: 'حفظ',

      // ── Upload box ───────────────────────────────────────
      // ── Launch splash ────────────────────────────────────
      splashTagline: 'استوديو الصور بالذكاء الاصطناعي',

      tapToSelect: 'اضغط لاختيار صورة',
      supportsFormats: 'الصيغ المدعومة: JPG وPNG وWebP',

      // ── Loading ──────────────────────────────────────────
      processing: 'جارٍ المعالجة…',

      // ── Compare ──────────────────────────────────────────
      original: 'الأصلية',

      // ── Crop actions ─────────────────────────────────────
      apply: 'تطبيق',
      cancel: 'إلغاء',
      cropHint: 'اختر «حرّ» ثم اسحب على الصورة لاقتصاصها',
      free: 'حرّ',

      // ── Edit sub-tabs ────────────────────────────────────
      filters: 'الفلاتر',
      light: 'الإضاءة',
      color: 'الألوان',
      mix: 'مزج',
      curves: 'المنحنيات',
      detail: 'التفاصيل',
      crop: 'اقتصاص',

      // ── Tools sub-tabs ───────────────────────────────────
      eraser: 'الممحاة',
      aiMask: 'قناع ذكي',
      portrait: 'بورتريه',
      enhanceFace: 'تحسين الوجه',
      autoEnhance: 'تحسين تلقائي',

      // ── Nav tabs ─────────────────────────────────────────
      navEdit: 'التعديل',
      navTools: 'الأدوات',
      navFrame: 'الإطارات',
      navSettings: 'الإعدادات',

      // ── Light sliders ────────────────────────────────────
      brightness: 'السطوع',
      contrast: 'التباين',
      exposure: 'التعريض',
      shadows: 'الظلال',
      whites: 'الأبيض',
      blacks: 'الأسود',

      // ── Color sliders ────────────────────────────────────
      saturation: 'التشبع',
      vibrance: 'الحيوية',
      warmth: 'الدفء',
      tint: 'الصبغة',

      // ── Mix sliders ──────────────────────────────────────
      hue: 'تدرّج اللون',
      sat: 'التشبّع',
      luma: 'إضاءة',

      // ── Curves ───────────────────────────────────────────
      curvesHint: 'اسحب النقاط لضبط الدرجات اللونية',
      curveRed: 'أحمر',
      curveGreen: 'أخضر',
      curveBlue: 'أزرق',
      curveReset: 'إعادة ضبط',
      curveResetAria: 'إعادة ضبط هذا المنحنى',
      segOffline: 'أنت غير متصل بالإنترنت. نموذج الاقتطاع الذكي غير مُحمَّل على جهازك بعد؛ اتصل مرة واحدة لتنزيله ثم حاول مجددًا.',
      segLoadTimeout: 'يستغرق تنزيل النموذج وقتًا أطول من المعتاد. تحقق من اتصالك وحاول مجددًا.',
      segLoadFailed: 'تعذّر تحميل نموذج الذكاء الاصطناعي. تحقق من اتصالك وحاول مجددًا.',
      segTimeout: 'استغرق التحليل وقتًا أطول من المعتاد. حاول مرة أخرى.',
      segFailed: 'تعذّر تحليل الصورة. حاول مرة أخرى.',

      // ── Detail sliders ───────────────────────────────────
      sharpness: 'الحدّة',
      clarity: 'الوضوح',
      vignette: 'تعتيم الحواف',
      grain: 'الحبيبات',

      // ── Portrait panel ───────────────────────────────────
      portraitMode: 'وضع البورتريه',
      portraitDesc: 'اسحب أحد المنزلقين لتمويه الخلفية أو تنعيم البشرة، أو اضغط «تحديد نقطة التركيز» ثم المس الشخص.',
      blurAmount: 'شدة التمويه',
      skinSmoothing: 'تنعيم البشرة',
      setFocus: 'تحديد نقطة التركيز',
      saveResult: 'حفظ النتيجة',
      reapply: 'إعادة التطبيق',
      portraitFailed: 'تعذّر إنشاء صورة البورتريه. حاول مرة أخرى.',
      tryAgain: 'حاول مرة أخرى',
      portraitBusyRetry: 'الخادم مشغول — جارٍ إعادة المحاولة…',
      errPortraitBusy: 'ميزة البورتريه مشغولة حاليًا. حاول مرة أخرى بعد لحظات.',

      // ── Enhance Face panel ───────────────────────────────
      enhanceFaceTitle: 'تحسين الوجه',
      enhanceFaceDesc: 'حسّن البشرة والتفاصيل ودرجات اللون والحدّة — مباشرةً على جهازك.',

      // ── Auto Enhance panel ───────────────────────────────
      autoEnhanceTitle: 'تحسين تلقائي',
      autoEnhanceDesc: 'يحلّل الصورة ويضبط السطوع والتباين والألوان والحدّة بلمسة واحدة.',

      // ── AI Mask ──────────────────────────────────────────
      aiMaskTitle: 'قناع ذكي',
      aiMaskHint: 'عدّل كل منطقة على حدة',
      aiMaskAutoBtn: 'تحسين تلقائي لكل المناطق',
      sky: 'السماء',
      person: 'الشخص',
      background: 'الخلفية',
      reset: 'إعادة ضبط',

      // ── Frame panel ──────────────────────────────────────
      all: 'الكل',
      minimal: 'بسيط',
      polaroid: 'بولارويد',
      film: 'فيلم',
      neon: 'نيون',
      luxury: 'فاخر',
      gradient: 'متدرّج',
      social: 'سوشيال',
      rounded: 'مستدير',
      vintage: 'ريترو',
      clean: 'نقي',
      thickness: 'السماكة',
      radius: 'استدارة الزوايا',
      shadow: 'الظل',
      padding: 'الهامش',
      frameColor: 'اللون',
      off: 'إيقاف',
      resetFrame: '↺ إعادة ضبط',

      // ── Magic Eraser ─────────────────────────────────────
      magicEraser: 'الممحاة السحرية',
      undo2: 'تراجع',
      redo: 'إعادة',
      clear: 'مسح',
      removeWithAI: 'إزالة بالذكاء الاصطناعي',
      before: 'قبل',
      downloadHD: 'تنزيل HD',
      brushSize: 'حجم الفرشاة',
      holdToCompare: 'اضغط باستمرار للمقارنة',
      removingObject: 'جارٍ إزالة العنصر…',
      processingPortrait: 'جارٍ معالجة البورتريه…',
      stagePreparing: 'جارٍ التحضير…',
      stageWaiting: 'بانتظار خادم الذكاء الاصطناعي…',
      stageReceiving: 'جارٍ استلام النتيجة…',
      stageBlending: 'جارٍ دمج النتيجة مع صورتك…',
      stageApplying: 'لمسات أخيرة…',
      etaUsually: 'عادةً نحو {s} ث',

      // ── Premium modal ────────────────────────────────────
      premiumTitle: 'YoFilter',
      premiumSubtitle: 'افتح أدوات التحرير الاحترافية',
      premiumPrice: '$4.99',
      premiumPricePeriod: '/شهر',
      premiumF1: 'تصدير بجودة عالية دون حدود',
      premiumF2: 'عزل دقيق للعناصر',
      premiumF3: 'جميع الفلاتر والتأثيرات المميّزة',
      premiumF4: 'التعديل على عدة صور والمزامنة السحابية',
      premiumF5: 'بدون علامة مائية',
      upgradeNow: 'ترقية الآن',
      later: 'ليس الآن',

      // ── Export modal ─────────────────────────────────────
      exportTitle: 'تصدير الصورة',
      exportSubtitle: 'اختر الصيغة. تُصدَّر الصور بدقة التحرير (حتى 2560 بكسل للضلع الأطول).',
      lowQuality: 'ملف صغير (JPEG 60%)',
      lowQualityTag: 'الأصغر حجمًا · فقدان بسيط في التفاصيل',
      normalQuality: 'قياسي (JPEG 92%)',
      normalQualityTag: 'توازن بين الحجم والجودة',
      ultraQuality: 'بدون فقدان (PNG)',
      ultraQualityTag: 'بدون فقدان في الجودة · الأكبر حجمًا',

      // ── Settings ─────────────────────────────────────────
      back: 'رجوع',
      settingsTitle: 'الإعدادات',
      language: 'اللغة',
      aboutApp: 'حول YoFilter',

      // ── About App ────────────────────────────────────────
      aboutTitle: 'حول YoFilter',
      appName: 'YoFilter',
      appVersion: 'الإصدار 1.0.0',
      appDescription: 'YoFilter استوديو صور مدعوم بالذكاء الاصطناعي، يمنحك أدوات احترافية مباشرةً من متصفحك. عدّل صورك وحسّنها وحوّلها بكل سهولة.',
      keyFeatures: 'أبرز المميزات',
      feature1: 'إزالة الخلفية ووضع البورتريه بالذكاء الاصطناعي',
      feature2: 'الممحاة السحرية لإزالة العناصر غير المرغوبة',
      feature3: 'فلاتر متقدمة وإعدادات جاهزة وتدرّج لوني احترافي',
      feature4: 'تحسين تلقائي ذكي',
      feature5: 'استوديو إطارات بأكثر من 50 إطارًا احترافيًا',
      feature6: 'تعمل معظم الأدوات دون إنترنت؛ الممحاة السحرية والبورتريه تتطلبان خادم الذكاء الاصطناعي',
      developer: 'المطوّر',
      developerName: 'ياسين محمد',
      contactEmail: 'البريد الإلكتروني',
      contactEmailVal: 'mmyasomm@gmail.com',
      privacyPolicy: 'سياسة الخصوصية',
      privacyPolicyText: 'خصوصيتك تهمنا. تتم معالجة الفلاتر والإعدادات المسبقة والمنحنيات ومزج الألوان والقص والإطارات وإزالة الخلفية وأقنعة الذكاء الاصطناعي وتحسين الوجه على جهازك. هناك ميزتان ترسلان الصورة التي تعدّلها عبر الإنترنت إلى خادم YoFilter للذكاء الاصطناعي: الممحاة السحرية (الصورة والمنطقة التي رسمتها) والبورتريه (الصورة وإعدادات التمويه والبشرة). يستخدم الخادم هذه البيانات فقط لإنشاء النتيجة وإعادتها، ويحتفظ بها في الذاكرة ولا يحفظ صورك على القرص. قد يسجّل تفاصيل تقنية مثل الوقت وحجم الملف وعنوان IP، ولا يسجّل الصورة نفسها. تعمل إزالة الخلفية وأقنعة الذكاء الاصطناعي على جهازك لكنها تنزّل نموذجها من شبكة CDN عامة أول مرة ما لم يكن مضمّناً مع التطبيق. لا نطلب حساباً ولا نجمع بيانات شخصية. تُحفظ الصور المُصدَّرة على جهازك فقط.',
      termsOfService: 'شروط الخدمة',
      termsText: 'باستخدامك YoFilter، فإنك توافق على استخدام التطبيق وفقًا للقوانين المعمول بها. تحتفظ بالملكية الكاملة لكل صورة تعدّلها. يُقدَّم التطبيق «كما هو» دون أي ضمان.',
      openSourceLicenses: 'تراخيص المصادر المفتوحة',
      licensesText: 'يستخدم YoFilter التقنيات مفتوحة المصدر التالية: MediaPipe (Apache 2.0) — نماذج فصل العناصر بالذكاء الاصطناعي. Google Fonts (SIL Open Font License) — خطوط Inter وTajawal وNoto Sans Arabic.',

      // ── Toast / loading messages ─────────────────────────
      toastLoadImage: 'افتح صورة أولاً',
      toastAnalyzing: 'جارٍ تحليل الصورة…',
      toastOptimalSettings: 'جارٍ اختيار أفضل التعديلات…',
      toastComingSoon: 'النسخة المميّزة قريبًا',
      toastBgFailed: 'تعذّرت إزالة الخلفية. حاول مرة أخرى.',
      toastOpenPhoto: 'افتح صورة أولاً',
      loadingRemoving: 'جارٍ إزالة الخلفية…',
      loadingLocalAI: 'جارٍ تحميل نموذج الذكاء الاصطناعي…',
      loadingPreparing: 'جارٍ تحديد الشخص في الصورة…',
      loadingIsolating: 'جارٍ عزل العنصر الرئيسي…',
      loadingTransparent: 'جارٍ إنشاء PNG شفاف…',

      // ── V22: toasts, ARIA/alt, export, watermark ─────────
      loadingImage: 'جارٍ تحميل الصورة…',
      toastImageLoadFailed: 'تعذّر فتح هذه الصورة. جرّب ملفًا آخر.',
      toastFileReadFailed: 'تعذّرت قراءة الملف. جرّب صورة أخرى.',
      toastBackToExit: 'اضغط رجوع مرة أخرى للخروج',
      toastBackBusy: 'العمل لا يزال جاريًا — اضغط رجوع مرة أخرى للخروج رغم ذلك',
      toastLoadFailed: 'تعذّر تحميل الصورة. حاول مرة أخرى.',
      toastSyncFailed: 'النتيجة جاهزة، لكن تعذّرت إضافتها إلى المحرر. حاول مرة أخرى.',
      swipeNothingToUndo: 'لا شيء للتراجع عنه',
      swipeRedoSoon: 'الإعادة غير متاحة بعد',
      stateOn: 'تشغيل',
      toastNoImageExport: 'افتح صورة للتصدير',
      toastExportBusy: 'التصدير جارٍ بالفعل — لحظة من فضلك',
      exportingLow: 'جارٍ التصدير بصيغة JPEG 60%…',
      exportingLowSub: 'أصغر حجم ممكن للملف',
      exportingNormal: 'جارٍ التصدير بصيغة JPEG 92%…',
      exportingNormalSub: 'توازن بين الحجم والجودة',
      exportingUltra: 'جارٍ التصدير بصيغة PNG بدون فقدان…',
      exportingUltraSub: 'بدون فقدان في الجودة · ملف كبير',
      exportLabelPng: 'PNG بدون فقدان',
      exportLabelJpeg: 'JPEG {q}%',
      toastExportShared: 'تمت المشاركة ({label} · {size} م.ب)',
      toastExportSaved: 'تم الحفظ ({label} · {size} م.ب)',
      toastExportFailed: 'تعذّر تصدير الصورة. حاول مرة أخرى.',
      toastSavedName: 'تم الحفظ باسم {name}',
      toastSaveFailed: 'تعذّر حفظ الصورة. تحقق من مساحة التخزين وحاول مرة أخرى.',
      watermarkLabel: 'إضافة علامة مائية عند التصدير',
      watermarkHint: 'تُضاف علامة “yf” صغيرة في الزاوية السفلية للصور المُصدَّرة.',
      loadingFilter: 'جارٍ تطبيق الفلتر…',
      loadingFilterSub: 'لحظة من فضلك',
      maskReady: 'جاهز — اضبط المنزلقات ثم اضغط تطبيق',
      maskPreparing: 'جارٍ اكتشاف المناطق',
      maskAnalyzeFailed: 'تعذّر تحليل الصورة. حاول مرة أخرى.',
      maskPickRegion: 'اختر منطقة أولاً: السماء أو الشخص أو الخلفية',
      maskAdjustFirst: 'حرّك أحد المنزلقات أولاً',
      maskApplyingTitle: 'جارٍ تطبيق القناع الذكي…',
      maskRegionSub: 'المنطقة: {region}',
      maskApplyingTo: 'جارٍ التطبيق على {region}…',
      maskBlending: 'جارٍ الدمج…',
      maskFinalizing: 'لمسات أخيرة…',
      maskStack: 'تم التطبيق — اختر منطقة أخرى لمتابعة التعديل',
      maskFailed: 'تعذّر تطبيق القناع. حاول مرة أخرى.',
      maskAutoTitle: 'جارٍ التحسين…',
      maskAutoSub: 'جارٍ اكتشاف المناطق',
      maskAutoStatus: 'جارٍ تحسين السماء والشخص والخلفية…',
      maskAnalyzingTones: 'جارٍ تحليل الدرجات اللونية…',
      maskBlendingAll: 'جارٍ دمج السماء والخلفية والشخص…',
      maskEnhancedHint: 'تم التحسين — اختر منطقة لضبطها بدقة',
      maskAutoFailed: 'تعذّر تحسين الصورة. حاول مرة أخرى.',
      loadingEnhancing: 'جارٍ تحسين البورتريه…',
      loadingEnhancingSub: 'يتم التحسين على جهازك',
      loadingDetectSkin: 'جارٍ رصد درجات البشرة والوجه…',
      loadingSharpness: 'جارٍ تحسين الحدّة…',
      toastEnhanceFailed: 'تعذّر تحسين البورتريه. حاول مرة أخرى.',
      toastNoResultDownload: 'لا توجد نتيجة للتنزيل بعد',
      toastPortraitShared: 'تمت المشاركة ({size} م.ب)',
      toastPortraitSaved: 'تم الحفظ ({size} م.ب)',
      toastDownloadFailed: 'تعذّر تنزيل الصورة. حاول مرة أخرى.',
      toastRestoreFailed: 'تعذّرت استعادة الصورة الأصلية.',
      errPortraitModel: 'ميزة البورتريه غير متاحة حاليًا. حاول لاحقًا.',
      edgePreparing: 'جارٍ تجهيز ميزات الذكاء الاصطناعي (تنزيل لمرة واحدة)…',
      edgeVerifying: 'جارٍ التحقق من التنزيل…',
      edgeStarting: 'جارٍ تشغيل الذكاء الاصطناعي على الجهاز…',
      edgeReady: 'الذكاء الاصطناعي على الجهاز جاهز',
      edgeMb: '{done} / {total} م.ب',
      edgeRetry: 'إعادة المحاولة',
      edgeErrOffline: 'أنت غير متصل بالإنترنت. اتصل مرة واحدة لتنزيل نموذج الذكاء الاصطناعي ثم حاول مجددًا.',
      edgeErrNetwork: 'انقطع التنزيل. تحقق من اتصالك وحاول مجددًا.',
      edgeErrHttp: 'خادم نموذج الذكاء الاصطناعي غير متاح حاليًا ({status}). حاول لاحقًا.',
      edgeErrCorrupt: 'النموذج الذي تم تنزيله تالف. حاول مرة أخرى.',
      edgeErrQuota: 'لا توجد مساحة كافية لنموذج الذكاء الاصطناعي. وفّر نحو 100 م.ب وحاول مجددًا.',
      edgeErrRuntime: 'تعذّر تشغيل الذكاء الاصطناعي على الجهاز، لذا سيتم استخدام الخادم.',
      edgeErrGeneric: 'تعذّر تجهيز ميزات الذكاء الاصطناعي. حاول مرة أخرى.',
      errImageTooLarge: 'حجم الصورة كبير جدًا (الحد الأقصى 25 م.ب)',
      errServerStatus: 'حدث خطأ في الخادم ({status}). حاول مرة أخرى.',
      errNotImage: 'لم يُرجع الخادم صورة. حاول مرة أخرى.',
      errProcessedLoad: 'تعذّر تحميل الصورة المعالَجة.',
      toastNothingToErase: 'ارسم فوق العنصر الذي تريد إزالته أولاً',
      toastSelectionTooLarge: 'المنطقة المحددة كبيرة جدًا. الحد الأقصى للعرض هو {max} بكسل.',
      toastPngShared: 'تمت المشاركة (PNG · {size} م.ب)',
      toastPngSaved: 'تم الحفظ (PNG · {size} م.ب)',
      toastCropTooSmall: 'منطقة الاقتصاص صغيرة جدًا. كبّرها وحاول مجددًا.',
      toastCropNoArea: 'حدّد منطقة للاقتصاص أولاً',
      toastCropFailed: 'تعذّر اقتصاص الصورة. حاول مرة أخرى.',
      announceCropSize: 'منطقة الاقتصاص {w} × {h} بكسل',
      frameColorUnavailable: 'اللون المخصص غير متاح لهذا الإطار',
      apiUnreachable: 'تعذّر الاتصال بخادم الذكاء الاصطناعي. تحقق من اتصالك وحاول مجددًا.',
      apiGeneric: 'حدث خطأ ما. حاول مرة أخرى.',
      apiTimeout: 'استغرق الخادم وقتًا طويلًا للرد. جرّب منطقة أصغر أو حاول مرة أخرى.',
      apiTooLarge: 'الصورة كبيرة جدًا للخادم (الحد الأقصى 25 م.ب).',
      apiTooMany: 'طلبات كثيرة جدًا. انتظر قليلًا ثم حاول مجددًا.',
      apiModelNotLoaded: 'نموذج الذكاء الاصطناعي ليس جاهزًا على الخادم بعد. حاول بعد قليل.',
      apiNotFound: 'خدمة الذكاء الاصطناعي غير متاحة على هذا العنوان.',
      apiRejected: 'تعذّر على الخادم قبول هذا الطلب.',
      apiServerError: 'واجه الخادم مشكلة أثناء معالجة الصورة.',
      apiSeeLog: ' حاول مرة أخرى لاحقًا.',
      apiStatus: 'حدث خطأ في الخادم ({status}). حاول مرة أخرى.',
      apiNoBase: 'خادم الذكاء الاصطناعي غير مُعدّ في هذا الإصدار من التطبيق.',
      altMainImage: 'الصورة قيد التعديل',
      altOriginalImage: 'الصورة الأصلية قبل التعديل',
      ariaHoldOriginal: 'اضغط باستمرار لرؤية الأصل',
      ariaCurvesCanvas: 'محرر منحنى الدرجات اللونية',
      ariaPortraitTools: 'أدوات البورتريه',
      ariaClose: 'إغلاق',
      ariaMainNav: 'التنقل الرئيسي',
      ariaEditTools: 'أدوات التعديل',
      ariaAiTools: 'أدوات الذكاء الاصطناعي',
      ariaFrameCats: 'فئات الإطارات',
      ariaFrameGrid: 'الإطارات',
      ariaFilterGrid: 'الفلاتر',
      ariaCropRatios: 'نسبة الاقتصاص',
      ariaMaskRegions: 'المنطقة المراد ضبطها',
      ariaMixColors: 'اللون المراد ضبطه',
      ariaCropBox: 'منطقة الاقتصاص',
      ariaLoading: 'جارٍ العمل، يرجى الانتظار',
      announceShowingOriginal: 'يتم عرض الصورة الأصلية',
      announceShowingEdited: 'يتم عرض الصورة المعدَّلة',
      mixRed: 'أحمر',
      mixOrange: 'برتقالي',
      mixYellow: 'أصفر',
      mixGreen: 'أخضر',
      mixAqua: 'سماوي',
      mixBlue: 'أزرق',
      mixPurple: 'بنفسجي',
      mixMagenta: 'أرجواني',
    }
  };

  // ── Core translate function ───────────────────────────────────
  // t(key)               -> translated string (falls back to English, then to the key itself)
  // t(key, { name: 'x' })  -> replaces {name} placeholders
  window.t = function (key, params) {
    var lang = (typeof currentLanguage !== 'undefined') ? currentLanguage : 'en';
    var dict = translations[lang] || translations.en;
    var s = dict[key] || translations.en[key] || key;
    if (params) {
      s = s.replace(/\{(\w+)\}/g, function (m, k) {
        return params[k] !== undefined && params[k] !== null ? String(params[k]) : m;
      });
    }
    return s;
  };

  // ── Apply all data-i18n attributes in the DOM ─────────────────
  window.applyI18n = function () {
    var lang = (typeof currentLanguage !== 'undefined') ? currentLanguage : 'en';
    var isRTL = (lang === 'ar');

    // Direction + lang attribute on <html>
    document.documentElement.lang = lang;
    document.documentElement.dir  = isRTL ? 'rtl' : 'ltr';

    // Body RTL class for CSS overrides
    if (isRTL) {
      document.body.classList.add('rtl');
    } else {
      document.body.classList.remove('rtl');
    }

    // Update all elements with data-i18n
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = el.getAttribute('data-i18n');
      if (key) el.textContent = window.t(key);
    }

    // Update placeholders
    var phs = document.querySelectorAll('[data-i18n-placeholder]');
    for (var j = 0; j < phs.length; j++) {
      var phKey = phs[j].getAttribute('data-i18n-placeholder');
      if (phKey) phs[j].placeholder = window.t(phKey);
    }

    // Y11: image alternative text and ARIA labels
    var alts = document.querySelectorAll('[data-i18n-alt]');
    for (var a = 0; a < alts.length; a++) {
      var aKey = alts[a].getAttribute('data-i18n-alt');
      if (aKey) alts[a].setAttribute('alt', window.t(aKey));
    }
    var arias = document.querySelectorAll('[data-i18n-aria]');
    for (var r = 0; r < arias.length; r++) {
      var rKey = arias[r].getAttribute('data-i18n-aria');
      if (rKey) arias[r].setAttribute('aria-label', window.t(rKey));
    }

    // Update title attributes (tooltips)
    var titles = document.querySelectorAll('[data-i18n-title]');
    for (var k = 0; k < titles.length; k++) {
      var tKey = titles[k].getAttribute('data-i18n-title');
      if (tKey) titles[k].title = window.t(tKey);
    }

    // Dynamic components (frame grid, colour dots, switches) re-render their own labels on this event.
    try {
      document.dispatchEvent(new CustomEvent('yofilter:i18n', { detail: { lang: lang } }));
    } catch (e) { /* very old WebView without CustomEvent constructor: components refresh on next render */ }
  };

  // ── Helpers used in JS modules ────────────────────────────────
  // These patch English-only messages to use the translation system.
  window._patchI18nMessages = function () {
    // Already done via applyI18n() for DOM elements.
    // JS modules call window.t() directly for runtime messages.
  };

})();
