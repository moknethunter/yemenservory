-keepclassmembers class com.example.yemensurveyor.MainActivity$* {
    public *;
}
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

-keepclassmembers class * extends android.webkit.WebViewClient {
    public *;
}
