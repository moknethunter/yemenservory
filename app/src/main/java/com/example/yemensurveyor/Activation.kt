package com.example.yemensurveyor

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.util.Patterns
import org.json.JSONObject
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Calendar
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone

class Activation(context: Context) {
    data class License(val email: String, val plan: String, val expiresAt: Long)

    private val settings = context.getSharedPreferences("survey_activation_v1", Context.MODE_PRIVATE)
    private val trialSettings = context.getSharedPreferences("survey_free_trial_v1", Context.MODE_PRIVATE)
    private val bootCount = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
    private val flags = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
    val device: String = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        ?.takeIf { it.isNotBlank() }?.let { identifier ->
            MessageDigest.getInstance("SHA-256").digest("yemen-surveyor:$identifier".toByteArray())
                .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        }.orEmpty()
    val ownerEmail: String = BuildConfig.SURVEY_SUPPORT_EMAIL
    private val key = runCatching {
        KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(
            Base64.decode(BuildConfig.SURVEY_LICENSE_PUBLIC_KEY, Base64.DEFAULT)
        ))
    }.getOrNull()
    val configured: Boolean get() = ownerEmail.isNotBlank() && key != null && device.isNotBlank()

    private var stored: License? = settings.getString("token", null)?.let(::verify)
    private val savedTrialStart = trialSettings.getLong("startedAt", 0).takeIf {
        it > 0 && trialSettings.getString("device", null) == device
    } ?: 0
    private var freeTrial = savedTrialStart.takeIf { it > 0 }?.let(::trialLicense)
    private var lastObserved = maxOf(settings.getLong("lastSeen", 0), savedTrialStart)
    private var lastElapsed = settings.getLong("elapsed", 0)
    private var lastBoot = settings.getInt("boot", -1)
    var reason: String = ""
        private set

    fun validEmail(raw: String): String? = raw.trim().lowercase(Locale.ROOT).takeIf {
        it.length in 3..254 && Patterns.EMAIL_ADDRESS.matcher(it).matches() &&
            it.all { character -> character.code in 33..126 }
    }

    fun license(): License? {
        val now = effectiveTime() ?: return null
        val signed = stored?.takeIf { configured && now < it.expiresAt }
        val trial = freeTrial ?: startTrial(now)
        val available = if (trial != null && now < trial.expiresAt &&
            (signed == null || trial.expiresAt > signed.expiresAt)
        ) trial else signed
        reason = when {
            available != null -> ""
            trial == null -> "تعذّر حفظ تاريخ بدء الفترة المجانية. أعد فتح التطبيق."
            !configured -> "انتهت الفترة المجانية. يلزم إعداد بريد الإدارة ومفتاح التفعيل لهذه النسخة."
            stored?.let { it.expiresAt >= trial.expiresAt } == true ->
                "انتهت صلاحية الترخيص. تواصل مع الإدارة لتجديد التفعيل."
            else -> "انتهت الأشهر الستة المجانية. اطلب رمز التفعيل من الإدارة."
        }
        return available
    }

    private fun startTrial(now: Long): License? {
        if (!trialSettings.edit().putLong("startedAt", now).putString("device", device).commit()) {
            return null
        }
        return trialLicense(now).also { freeTrial = it }
    }

    private fun trialLicense(start: Long): License {
        val end = GregorianCalendar(TimeZone.getTimeZone("UTC")).apply {
            timeInMillis = start * 1000
            add(Calendar.MONTH, 6)
        }.timeInMillis / 1000
        return License("", "trial", end)
    }

    private fun effectiveTime(): Long? {
        val elapsed = SystemClock.elapsedRealtime() / 1000
        val wall = System.currentTimeMillis() / 1000
        val continued = if (bootCount >= 0 && bootCount == lastBoot && elapsed >= lastElapsed) {
            lastObserved + elapsed - lastElapsed
        } else lastObserved
        if (wall <= 0 || wall < lastObserved - 300) {
            reason = "صحّح تاريخ الهاتف ووقته لتأكيد صلاحية الترخيص"
            return null
        }
        val now = maxOf(wall, continued)
        if (now - lastObserved >= 10 || elapsed < lastElapsed || bootCount != lastBoot) {
            lastObserved = now
            lastElapsed = elapsed
            lastBoot = bootCount
            settings.edit().putLong("lastSeen", now).putLong("elapsed", elapsed).putInt("boot", bootCount).apply()
        }
        return now
    }

    fun activate(email: String, token: String): String {
        val normalized = validEmail(email) ?: return "تحقق من عنوان البريد الإلكتروني"
        if (!configured) return "تحتاج النسخة إلى إعداد مفتاح الترخيص وبريد الإدارة"
        val value = verify(token) ?: return "رمز التفعيل غير صالح لهذا الجهاز"
        if (value.email != normalized) return "استخدم عنوان البريد الذي استلم رمز التفعيل"
        val now = effectiveTime() ?: return reason
        if (value.expiresAt <= now) {
            return "انتهت صلاحية هذا الرمز"
        }
        if (!settings.edit().putString("token", token.trim()).commit()) return "تعذر حفظ التفعيل"
        stored = value
        return if (license() != null) "تم التفعيل" else reason
    }

    private fun verify(token: String): License? = runCatching {
        require(token.length in 120..1400)
        val parts = token.trim().split('.')
        require(parts.size == 2)
        val payload = Base64.decode(parts[0], flags)
        val signature = Base64.decode(parts[1], flags)
        val validator = Signature.getInstance("SHA256withECDSA")
        validator.initVerify(key ?: return null)
        validator.update(payload)
        require(validator.verify(signature))

        val claim = JSONObject(payload.toString(Charsets.UTF_8))
        require(device.isNotBlank() && claim.getString("device") == device)
        require(claim.getString("app") == "yemen-surveyor" && claim.getInt("v") == 1)
        val email = validEmail(claim.getString("email")) ?: return null
        val plan = claim.getString("plan")
        val issued = claim.getLong("issued")
        val expiration = claim.getLong("exp")
        require(issued > 0 && expiration > issued && plan in setOf("trial", "paid"))
        require(issued <= System.currentTimeMillis() / 1000 + 300)
        License(email, plan, expiration)
    }.getOrNull()
}
