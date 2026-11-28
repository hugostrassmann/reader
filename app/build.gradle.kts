plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Versionsnummer: bei jedem Umbau hier erhöhen. Sie steht dann auch im APK-Dateinamen.
val appVersion = "4.0"

base {
    archivesName.set("EpubReader-v$appVersion")
}

android {
    namespace = "com.example.epubreader"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.epubreader"
        minSdk = 24
        targetSdk = 35
        versionCode = 40
        versionName = appVersion
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions { jvmTarget = "11" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
