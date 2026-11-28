package com.example.epubreader

import android.annotation.SuppressLint
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.WindowInsetsCompat
import java.io.ByteArrayInputStream
import java.io.IOException
import android.content.Intent
import android.provider.DocumentsContract

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var fullscreenOn = true   // App startet im Vollbild

    private class ImpFile(val name: String, val size: Long, val modified: Long, val uri: Uri)

    @Volatile
    private var impFiles: List<ImpFile> = emptyList()

    private val folderPicker =
        registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
            if (uri != null) {
                try {
                    contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                } catch (e: Exception) { }
                getSharedPreferences("epub", MODE_PRIVATE).edit().putString("importTree", uri.toString()).apply()
                scanTree(uri)
            }
        }

    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            filePathCallback?.onReceiveValue(uris)
            filePathCallback = null
        }

    // Datei speichern (Export): Nutzer wählt Ziel, JS schickt die Daten in Stücken
    private var saveStream: java.io.OutputStream? = null
    private var saveFailed = false

    private fun jsSaveEvent(ev: String) {
        runOnUiThread { webView.evaluateJavascript("window.__saveEvent && window.__saveEvent('" + ev + "')", null) }
    }

    private val fileSaver =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uri = result.data?.data
            if (result.resultCode == RESULT_OK && uri != null) {
                try {
                    saveStream = contentResolver.openOutputStream(uri, "wt")
                    saveFailed = saveStream == null
                } catch (e: Exception) {
                    saveStream = null; saveFailed = true
                }
                jsSaveEvent(if (saveFailed) "error" else "ready")
            } else {
                jsSaveEvent("cancel")
            }
        }

    // Export in einen Ordner (mehrere Dateien): Nutzer wählt den Ordner einmal
    private var exportTree: Uri? = null
    private val dirSaver =
        registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
            if (uri != null) { exportTree = uri; jsSaveEvent("dirready") }
            else { exportTree = null; jsSaveEvent("cancel") }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Versionsanzeige beim Start, damit man sieht, welche APK installiert ist
        try {
            val info = packageManager.getPackageInfo(packageName, 0)
            @Suppress("DEPRECATION")
            val code = info.versionCode
            Toast.makeText(
                this,
                "EPUB-Reader Version ${info.versionName} (Build $code)",
                Toast.LENGTH_LONG
            ).show()
        } catch (e: Exception) {
            // Anzeige ist optional
        }

        webView = WebView(this)
        webView.setBackgroundColor(Color.TRANSPARENT)
        setContentView(webView)
        applyFullscreen(true)

        // Platz für Statusleiste, Navigationsleiste und Kamera-Ausschnitt lassen
        ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true          // localStorage + IndexedDB (Bücher, Einstellungen)
            allowFileAccess = false
            allowContentAccess = true
            cacheMode = WebSettings.LOAD_DEFAULT
            textZoom = 100
        }

        webView.addJavascriptInterface(Bridge(), "AndroidApp")
        webView.addJavascriptInterface(TtsBridge(), "AndroidTts")
        webView.addJavascriptInterface(FilesBridge(), "AndroidFiles")
        initTts()

        webView.webViewClient = object : WebViewClient() {

            // Die App wird aus den mitgelieferten Dateien (assets) geladen,
            // unter einer https-Adresse, damit die Datenspeicherung dauerhaft funktioniert.
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val url = request.url
                if (url.host != HOST) return null
                var path = url.path ?: "/"
                if (path.startsWith("/__import/")) {
                    val f = impFiles.getOrNull(path.removePrefix("/__import/").toIntOrNull() ?: -1)
                    return try {
                        if (f == null) throw IOException("no file")
                        val stream = contentResolver.openInputStream(f.uri) ?: throw IOException("no stream")
                        WebResourceResponse(
                            "application/epub+zip", null, 200, "OK",
                            mapOf("Access-Control-Allow-Origin" to "*"), stream
                        )
                    } catch (e: Exception) {
                        WebResourceResponse(
                            "text/plain", "utf-8", 404, "Not Found",
                            emptyMap(), ByteArrayInputStream(ByteArray(0))
                        )
                    }
                }
                if (path == "/" || path.isEmpty()) path = "/index.html"
                return try {
                    val stream = assets.open(path.removePrefix("/"))
                    WebResourceResponse(mimeFor(path), "utf-8", stream)
                } catch (e: IOException) {
                    WebResourceResponse(
                        "text/plain", "utf-8", 404, "Not Found",
                        emptyMap(), ByteArrayInputStream(ByteArray(0))
                    )
                }
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean = request.url.host != HOST   // keine externen Seiten öffnen
        }

        // Dateiauswahl für das Öffnen von EPUBs
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                return try {
                    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                    }
                    fileChooser.launch(intent)
                    true
                } catch (e: Exception) {
                    filePathCallback = null
                    false
                }
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl("https://$HOST/index.html")
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        try { tts?.stop(); tts?.shutdown() } catch (e: Exception) { }
        webView.destroy()
        super.onDestroy()
    }

    // ---------- Sprachausgabe: Android-TextToSpeech für die Web-App ----------
    private fun initTts() {
        tts = TextToSpeech(applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                ttsReady = true
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) { sendTtsEvent("start", utteranceId) }
                    override fun onDone(utteranceId: String?) { sendTtsEvent("end", utteranceId) }
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) { sendTtsEvent("error", utteranceId, "synthesis-failed") }
                    override fun onError(utteranceId: String?, errorCode: Int) { sendTtsEvent("error", utteranceId, "synthesis-failed") }
                    override fun onStop(utteranceId: String?, interrupted: Boolean) { }
                })
                runOnUiThread {
                    webView.evaluateJavascript("window.__ttsReady && window.__ttsReady()", null)
                }
            }
        }
    }

    private fun sendTtsEvent(kind: String, rawId: String?, err: String = "") {
        val id = rawId ?: return
        val base = id.substringBefore('#')
        val flags = id.substringAfter('#', "")
        if (kind == "start" && !flags.contains('s')) return
        if (kind == "end" && !flags.contains('e')) return
        val js = "window.__ttsEvent && window.__ttsEvent('" + kind + "','" + base + "','" + err + "')"
        runOnUiThread { webView.evaluateJavascript(js, null) }
    }

    private fun splitForTts(text: String, max: Int): List<String> {
        if (text.length <= max) return listOf(text)
        val out = mutableListOf<String>()
        var rest = text
        while (rest.length > max) {
            var cut = rest.lastIndexOf(' ', max)
            if (cut <= 0) cut = max
            out.add(rest.substring(0, cut))
            rest = rest.substring(cut).trimStart()
        }
        if (rest.isNotEmpty()) out.add(rest)
        return out
    }

    inner class TtsBridge {
        @JavascriptInterface
        fun getVoices(): String {
            val arr = JSONArray()
            val t = tts
            if (t == null || !ttsReady) return "[]"
            try {
                val all = t.getVoices() ?: emptySet()
                for (v in all) {
                    if (v.getFeatures()?.contains("notInstalled") == true) continue
                    val loc = v.getLocale()
                    val variant = v.getName().substringAfter("-x-", "").substringBefore("-")
                    var label = loc.getDisplayName(Locale.GERMAN)
                    if (variant.isNotEmpty()) label += " – " + variant
                    if (v.isNetworkConnectionRequired()) label += " (online)"
                    arr.put(
                        JSONObject()
                            .put("name", label)
                            .put("voiceURI", v.getName())
                            .put("lang", loc.toLanguageTag())
                            .put("default", false)
                    )
                }
            } catch (e: Exception) { }
            return arr.toString()
        }

        @JavascriptInterface
        fun speak(id: String, text: String, voice: String, lang: String, rate: Double, pitch: Double) {
            val t = tts
            if (t == null || !ttsReady) {
                sendTtsEvent("error", id + "#", "synthesis-unavailable")
                return
            }
            if (text.isBlank()) {
                sendTtsEvent("start", id + "#s")
                sendTtsEvent("end", id + "#e")
                return
            }
            try {
                val v = if (voice.isNotEmpty()) t.getVoices()?.firstOrNull { it.getName() == voice } else null
                if (v != null) t.setVoice(v)
                else if (lang.isNotEmpty()) t.setLanguage(Locale.forLanguageTag(lang))
                t.setSpeechRate(rate.coerceIn(0.1, 4.0).toFloat())
                t.setPitch(pitch.coerceIn(0.1, 2.0).toFloat())
                val max = TextToSpeech.getMaxSpeechInputLength() - 100
                val pieces = splitForTts(text, max)
                for (i in pieces.indices) {
                    val flags = (if (i == 0) "s" else "") + (if (i == pieces.size - 1) "e" else "")
                    t.speak(pieces[i], TextToSpeech.QUEUE_ADD, null, id + "#" + flags)
                }
            } catch (e: Exception) {
                sendTtsEvent("error", id + "#", "synthesis-failed")
            }
        }

        @JavascriptInterface
        fun cancel() {
            try { tts?.stop() } catch (e: Exception) { }
        }
    }

    // ---------- Ordner-Import: EPUBs aus einem Ordner samt Unterordnern ----------
    private fun savedTree(): Uri? {
        val s = getSharedPreferences("epub", MODE_PRIVATE).getString("importTree", null) ?: return null
        val u = Uri.parse(s)
        val ok = contentResolver.persistedUriPermissions.any { it.uri == u && it.isReadPermission }
        return if (ok) u else null
    }

    private fun scanTree(tree: Uri) {
        Thread {
            val out = ArrayList<ImpFile>()
            try {
                walkTree(tree, DocumentsContract.getTreeDocumentId(tree), out, 0)
            } catch (e: Exception) { }
            impFiles = out
            val arr = JSONArray()
            for (i in out.indices) {
                val f = out[i]
                arr.put(JSONObject().put("i", i).put("name", f.name).put("size", f.size).put("mod", f.modified))
            }
            val js = "window.__folderList && window.__folderList(" + arr.toString() + ")"
            runOnUiThread { webView.evaluateJavascript(js, null) }
        }.start()
    }

    private fun walkTree(tree: Uri, docId: String, out: MutableList<ImpFile>, depth: Int) {
        if (depth > 15 || out.size > 20000) return
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED
        )
        contentResolver.query(children, cols, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0) ?: continue
                val name = c.getString(1) ?: ""
                val mime = c.getString(2) ?: ""
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    walkTree(tree, id, out, depth + 1)
                } else if (name.endsWith(".epub", ignoreCase = true)) {
                    out.add(ImpFile(name, c.getLong(3), c.getLong(4), DocumentsContract.buildDocumentUriUsingTree(tree, id)))
                }
            }
        }
    }

    inner class FilesBridge {
        @JavascriptInterface
        fun pickFolder() {
            runOnUiThread { folderPicker.launch(null) }
        }

        @JavascriptInterface
        fun saveStart(name: String, mime: String) {
            runOnUiThread {
                try { saveStream?.close() } catch (e: Exception) { }
                saveStream = null; saveFailed = false
                val i = Intent(Intent.ACTION_CREATE_DOCUMENT)
                i.addCategory(Intent.CATEGORY_OPENABLE)
                i.type = mime
                i.putExtra(Intent.EXTRA_TITLE, name)
                fileSaver.launch(i)
            }
        }

        @JavascriptInterface
        fun saveDirStart() {
            runOnUiThread { dirSaver.launch(null) }
        }

        @JavascriptInterface
        fun saveFileStart(name: String, mime: String): Boolean {
            try { saveStream?.close() } catch (e: Exception) { }
            saveStream = null; saveFailed = false
            val tree = exportTree ?: return false
            return try {
                val treeId = DocumentsContract.getTreeDocumentId(tree)
                val parent = DocumentsContract.buildDocumentUriUsingTree(tree, treeId)
                val kids = DocumentsContract.buildChildDocumentsUriUsingTree(tree, treeId)
                contentResolver.query(kids, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
                    while (c.moveToNext()) {
                        if (c.getString(1) == name) {
                            try { DocumentsContract.deleteDocument(contentResolver, DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0))) } catch (e: Exception) { }
                        }
                    }
                }
                val doc = DocumentsContract.createDocument(contentResolver, parent, mime, name)
                if (doc == null) false else {
                    saveStream = contentResolver.openOutputStream(doc, "wt")
                    saveStream != null
                }
            } catch (e: Exception) { saveStream = null; false }
        }

        @JavascriptInterface
        fun saveChunk(b64: String) {
            try {
                saveStream?.write(android.util.Base64.decode(b64, android.util.Base64.DEFAULT))
            } catch (e: Exception) { saveFailed = true }
        }

        @JavascriptInterface
        fun saveEnd(): Boolean {
            val ok = !saveFailed && saveStream != null
            try { saveStream?.flush(); saveStream?.close() } catch (e: Exception) { return false }
            saveStream = null
            return ok
        }

        @JavascriptInterface
        fun hasFolder(): Boolean = savedTree() != null

        @JavascriptInterface
        fun rescan(): Boolean {
            val u = savedTree() ?: return false
            scanTree(u)
            return true
        }
    }

    // Vollbild-Schalter für die Web-App: blendet Status- und Navigationsleiste aus/ein
    inner class Bridge {
        @JavascriptInterface
        fun setFullscreen(on: Boolean) {
            runOnUiThread { applyFullscreen(on) }
        }

        @JavascriptInterface
        fun isFullscreen(): Boolean = fullscreenOn
    }

    // Vollbild: Status- und Navigationsleiste aus-/einblenden
    private fun applyFullscreen(on: Boolean) {
        fullscreenOn = on
        val c = WindowCompat.getInsetsController(window, window.decorView)
        c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (on) c.hide(WindowInsetsCompat.Type.systemBars())
        else c.show(WindowInsetsCompat.Type.systemBars())
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && fullscreenOn) applyFullscreen(true)
    }

    private fun mimeFor(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "html", "htm" -> "text/html"
        "js" -> "application/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "svg" -> "image/svg+xml"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        "ttf" -> "font/ttf"
        else -> "application/octet-stream"
    }

    companion object {
        private const val HOST = "appassets.local"
    }
}
