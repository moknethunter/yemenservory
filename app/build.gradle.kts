plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val licenseKey = providers.gradleProperty("surveyLicensePublicKey").orElse("").get()
val supportEmail = providers.gradleProperty("surveySupportEmail").orElse("").get()
require(licenseKey.matches(Regex("[A-Za-z0-9+/=]*"))) { "Use the DER public key printed by licensing/manage.py." }
require(supportEmail.isEmpty() || supportEmail.matches(Regex("[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+"))) {
    "Set surveySupportEmail to a valid email address."
}

android {
    namespace = "com.example.yemensurveyor"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.yemensurveyor.app"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"

        buildConfigField("String", "SURVEY_LICENSE_PUBLIC_KEY", "\"$licenseKey\"")
        buildConfigField("String", "SURVEY_SUPPORT_EMAIL", "\"$supportEmail\"")
        resourceConfigurations += listOf("ar", "en")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("net.sf.geographiclib:GeographicLib-Java:2.0")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.2.0")
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
