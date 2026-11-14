package io.github.socrtwo.quillfolio;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.os.Build;
import android.os.PersistableBundle;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native file plumbing for Anne's Folio on Android.
 *
 * JS contract. Files read for the page are not sent over the bridge: they are copied (streamed) to
 * cache/opened/, and the page fetches them through the WebView's local server
 * (Capacitor.convertFileSrc(path)), then calls releaseFile. Files the page sends are either a base64
 * string ({@code data}, no line breaks) or, for large ones, a file the page wrote in cache/outgoing/ with the
 * Filesystem plugin ({@code path}), streamed from there and deleted.
 * <ul>
 *   <li>openDocument({mimeTypes: string[]}) -> {uri, name, mime, path, size} | {canceled: true}</li>
 *   <li>saveAs({name, mime, data | path}) -> {uri, name} | {canceled: true}</li>
 *   <li>writeUri({uri, data | path}) -> {ok: true}</li>
 *   <li>readUri({uri}) -> {uri, name, mime, path, size}</li>
 *   <li>releaseFile({path}) -> void: deletes a cache copy the page has read</li>
 *   <li>print({jobName}) -> void</li>
 *   <li>share({name, mime, data | path, title}) -> void</li>
 *   <li>getLaunchFile() -> {uri?, name, mime, path, size} | {} (consumed once; when several files were shared at
 *       once, the others follow as "fileOpened" events; shared plain text comes as {name, mime, data})</li>
 *   <li>keepAwake({on: boolean}) -> void</li>
 *   <li>event "fileOpened" -> same payload as getLaunchFile, for files opened while running</li>
 *   <li>secureSet({key, value}) / secureGet({key}) -> {value} / secureRemove({key}): Keystore-encrypted secrets</li>
 *   <li>readClipboard() -> {text} / writeClipboard({text, sensitive})</li>
 *   <li>startLoopback({timeoutMs, successHtml, path}) -> {port}; event "oauthCallback" {url} (requests for path only); stopLoopback().
 *       While it waits, {@link LoopbackService} keeps the app in the foreground state so Android does not freeze the listener.</li>
 * </ul>
 * Only content: URIs of other apps' providers are read or written (see {@link #isAllowedUri}).
 */
@CapacitorPlugin(name = "QuillNative")
public class QuillNativePlugin extends Plugin {

    private static final String TAG = "QuillNative";
    private static final String EVENT_FILE_OPENED = "fileOpened";
    private static final String SHARE_DIR = "shared";
    private static final long SHARE_FILE_MAX_AGE_MS = 24L * 60L * 60L * 1000L;
    /** Cache copies of opened files, waiting for the page to fetch them; emptied at every start. */
    private static final String OPENED_DIR = "opened";
    /** Files the page wrote for saving or sharing (Filesystem plugin, Directory.Cache); emptied at every start. */
    private static final String OUTGOING_DIR = "outgoing";

    /** Single background thread for file I/O so large documents never block the UI or the plugin queue. */
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** Large payloads waiting for an activity result, kept out of the call's saved state. */
    private static final java.util.Map<String, String> pendingData = new java.util.concurrent.ConcurrentHashMap<>();
    /**
     * Largest file opened (bytes). The copy is streamed, so this is not a limit of the native side: the page
     * holds the whole file in the WebView's memory once, plus what the PDF engine builds from it, and beyond
     * 1 GB that does not fit in a phone's WebView process. Bigger files are refused before the cache fills up.
     */
    private static final long MAX_READ_BYTES = 1024L * 1024L * 1024L;

    private AiSupport.Loopback loopback;

    private final Object launchLock = new Object();
    private boolean launchFileConsumed = false;

    @Override
    public void load() {
        // Copies left by the last run (the app was closed before the page read them, or a save failed).
        final File cache = getContext().getCacheDir();
        io.execute(() -> {
            deleteFilesIn(new File(cache, OPENED_DIR));
            deleteFilesIn(new File(cache, OUTGOING_DIR));
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (loopback != null) {
            loopback.stop();
        }
        LoopbackService.stop();
        io.shutdown();
        super.handleOnDestroy();
    }

    // ---------------------------------------------------------------------------------------------
    // AI setup: secrets, clipboard, OAuth loopback
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void secureSet(PluginCall call) {
        final String key = call.getString("key");
        final String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("secureSet requires 'key' and 'value'");
            return;
        }
        io.execute(() -> {
            try {
                AiSupport.put(getContext(), key, value);
                call.resolve();
            } catch (Throwable e) {
                call.reject("Could not store the secret: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        final String key = call.getString("key");
        if (key == null) {
            call.reject("secureGet requires 'key'");
            return;
        }
        io.execute(() -> {
            JSObject ret = new JSObject();
            try {
                ret.put("value", AiSupport.get(getContext(), key));
            } catch (Throwable e) {
                // A Keystore key lost after a device restore cannot decrypt old values: report none.
                Log.w(TAG, "secureGet failed", e);
                ret.put("value", JSObject.NULL);
            }
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        final String key = call.getString("key");
        if (key == null) {
            call.reject("secureRemove requires 'key'");
            return;
        }
        AiSupport.remove(getContext(), key);
        call.resolve();
    }

    @PluginMethod
    public void readClipboard(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject ret = new JSObject();
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = cm != null ? cm.getPrimaryClip() : null;
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence text = clip.getItemAt(0).coerceToText(getContext());
                    ret.put("text", text != null ? text.toString() : JSObject.NULL);
                } else {
                    ret.put("text", JSObject.NULL);
                }
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not read the clipboard: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void writeClipboard(PluginCall call) {
        final String text = call.getString("text", "");
        final boolean sensitive = Boolean.TRUE.equals(call.getBoolean("sensitive", false));
        getActivity().runOnUiThread(() -> {
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm == null) {
                    call.reject("No clipboard service");
                    return;
                }
                if ((text == null || text.isEmpty()) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    cm.clearPrimaryClip();
                } else {
                    ClipData clip = ClipData.newPlainText("Anne's Folio", text);
                    if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        PersistableBundle extras = new PersistableBundle();
                        extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
                        clip.getDescription().setExtras(extras);
                    }
                    cm.setPrimaryClip(clip);
                }
                call.resolve();
            } catch (Throwable e) {
                call.reject("Could not write the clipboard: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void startLoopback(PluginCall call) {
        long timeoutMs = call.getLong("timeoutMs", 600_000L);
        String html = call.getString("successHtml");
        String path = call.getString("path");
        synchronized (this) {
            if (loopback != null) {
                loopback.stop();
            }
            final AiSupport.Loopback lb;
            try {
                lb = new AiSupport.Loopback(timeoutMs, html, path, (url) -> {
                    LoopbackService.stop();
                    JSObject ev = new JSObject();
                    ev.put("url", url);
                    notifyListeners("oauthCallback", ev, true);
                });
            } catch (Throwable e) {
                call.reject("Could not start the sign-in listener: " + e.getMessage(), asException(e));
                return;
            }
            loopback = lb;
            Thread t = new Thread(() -> {
                try {
                    lb.run();
                } finally {
                    // Timed out or stopped. A listener that replaced this one keeps the service.
                    synchronized (QuillNativePlugin.this) {
                        if (loopback == lb || loopback == null) {
                            LoopbackService.stop();
                        }
                    }
                }
            }, "quillfolio-oauth");
            t.setDaemon(true);
            t.start();
            // Android 14+ freezes apps in the background: while the browser is in front, the listener
            // would not answer the redirect. A short foreground service keeps the app running meanwhile.
            LoopbackService.start(getContext());
            JSObject ret = new JSObject();
            ret.put("port", loopback.port());
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void stopLoopback(PluginCall call) {
        synchronized (this) {
            if (loopback != null) {
                loopback.stop();
                loopback = null;
            }
        }
        LoopbackService.stop();
        call.resolve();
    }

    // ---------------------------------------------------------------------------------------------
    // Open / save via the Storage Access Framework
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void openDocument(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        String[] mimeTypes = toStringArray(call.getArray("mimeTypes"));
        if (mimeTypes.length > 0) {
            intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        }
        try {
            startActivityForResult(call, intent, "openResult");
        } catch (ActivityNotFoundException e) {
            call.reject("No file picker is available on this device", e);
        }
    }

    @ActivityCallback
    private void openResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        final Uri uri = resultUri(result);
        if (uri == null) {
            resolveCanceled(call);
            return;
        }
        takePersistablePermission(uri);
        io.execute(() -> {
            try {
                call.resolve(readDocument(uri, null));
            } catch (Throwable e) {
                call.reject("Could not read document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void saveAs(PluginCall call) {
        String name = call.getString("name", "Untitled");
        String mime = call.getString("mime", "application/octet-stream");
        if (call.getString("data") == null && call.getString("path") == null) {
            call.reject("saveAs requires 'data' or 'path'");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        // Capacitor parcels the call's data into onSaveInstanceState while the picker is up;
        // a large base64 document there exceeds the 1 MB binder limit (TransactionTooLargeException).
        // A staged file ('path') is a short string and stays in the call.
        if (call.getString("data") != null) {
            pendingData.put(call.getCallbackId(), call.getString("data"));
            call.getData().remove("data");
        }
        try {
            startActivityForResult(call, intent, "saveResult");
        } catch (ActivityNotFoundException e) {
            pendingData.remove(call.getCallbackId());
            call.reject("No file picker is available on this device", e);
        }
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        final Uri uri = resultUri(result);
        final String data = pendingData.remove(call.getCallbackId());
        final String staged = call.getString("path");
        if (uri == null) {
            if (staged != null) {
                deleteStaged(staged);
            }
            resolveCanceled(call);
            return;
        }
        if (data == null && staged == null) {
            // The app process was recreated while the picker was open.
            call.reject("The document was not kept while the file picker was open. Please save again.");
            return;
        }
        io.execute(() -> {
            try {
                writePayload(uri, data, staged);
                takePersistablePermission(uri);
                String name = queryDisplayName(uri);
                JSObject ret = new JSObject();
                ret.put("uri", uri.toString());
                ret.put("name", name != null ? name : call.getString("name", ""));
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not save document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void writeUri(PluginCall call) {
        final String uriString = call.getString("uri");
        final String data = call.getString("data");
        final String staged = call.getString("path");
        if (uriString == null || uriString.isEmpty() || (data == null && staged == null)) {
            call.reject("writeUri requires 'uri' and 'data' or 'path'");
            return;
        }
        if (!isAllowedUri(Uri.parse(uriString))) {
            call.reject("This address cannot be written to: only documents chosen in the file picker or opened from another app");
            return;
        }
        io.execute(() -> {
            try {
                writePayload(Uri.parse(uriString), data, staged);
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Throwable e) {
                call.reject("Could not write document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void readUri(PluginCall call) {
        final String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.reject("readUri requires 'uri'");
            return;
        }
        if (!isAllowedUri(Uri.parse(uriString))) {
            call.reject("This address cannot be read: only documents chosen in the file picker or opened from another app");
            return;
        }
        io.execute(() -> {
            try {
                call.resolve(readDocument(Uri.parse(uriString), null));
            } catch (Throwable e) {
                call.reject("Could not read document: " + e.getMessage(), asException(e));
            }
        });
    }

    /** Deletes the cache copy of an opened file once the page has read it. Only files in cache/opened/. */
    @PluginMethod
    public void releaseFile(PluginCall call) {
        final String path = call.getString("path");
        io.execute(() -> {
            File f = cacheChild(OPENED_DIR, path);
            if (f != null && f.isFile() && !f.delete()) {
                Log.w(TAG, "Could not delete " + f.getName());
            }
            call.resolve();
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Print / share / screen
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void print(PluginCall call) {
        final String jobName = call.getString("jobName", "Anne's Folio document");
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("Printing is not available right now");
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                PrintManager printManager = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
                WebView webView = getBridge().getWebView();
                if (printManager == null || webView == null) {
                    call.reject("Printing is not available on this device");
                    return;
                }
                PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(jobName);
                printManager.print(jobName, adapter, new PrintAttributes.Builder().build());
                call.resolve();
            } catch (Throwable e) {
                call.reject("Could not start printing: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void share(PluginCall call) {
        final String name = sanitizeFileName(call.getString("name", "document"));
        final String mime = call.getString("mime", "application/octet-stream");
        final String data = call.getString("data");
        final String staged = call.getString("path");
        final String title = call.getString("title", name);
        if (data == null && staged == null) {
            call.reject("share requires 'data' or 'path'");
            return;
        }
        io.execute(() -> {
            try {
                Context context = getContext();
                File dir = new File(context.getCacheDir(), SHARE_DIR);
                if (!dir.isDirectory() && !dir.mkdirs()) {
                    throw new IOException("Cannot create " + dir.getAbsolutePath());
                }
                pruneOldShares(dir);
                File file = new File(dir, name);
                if (staged != null) {
                    File src = cacheChild(OUTGOING_DIR, staged);
                    if (src == null || !src.isFile()) {
                        throw new IOException("The file to share is missing");
                    }
                    if (!src.renameTo(file)) {
                        try (InputStream in = new FileInputStream(src)) {
                            copyToFile(in, file, Long.MAX_VALUE);
                        } finally {
                            deleteStaged(staged);
                        }
                    }
                } else {
                    try (FileOutputStream out = new FileOutputStream(file)) {
                        out.write(decodeBase64(data));
                    }
                }
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);

                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.putExtra(Intent.EXTRA_TITLE, name);
                send.setClipData(ClipData.newRawUri(name, uri));
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                final Intent chooser = Intent.createChooser(send, title);
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                final Activity activity = getActivity();
                if (activity == null) {
                    call.reject("Sharing is not available right now");
                    return;
                }
                activity.runOnUiThread(() -> {
                    try {
                        activity.startActivity(chooser);
                        call.resolve();
                    } catch (ActivityNotFoundException e) {
                        call.reject("No app is available to share with", e);
                    }
                });
            } catch (Throwable e) {
                call.reject("Could not share document: " + e.getMessage(), asException(e));
            }
        });
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", Boolean.TRUE));
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity not available");
            return;
        }
        activity.runOnUiThread(() -> {
            if (on) {
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            call.resolve();
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Files handed to us by other apps ("Open with" / "Share to")
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    public void getLaunchFile(PluginCall call) {
        Intent launchIntent = null;
        synchronized (launchLock) {
            if (!launchFileConsumed) {
                launchFileConsumed = true;
                Activity activity = getActivity();
                launchIntent = activity != null ? activity.getIntent() : null;
            }
        }
        // Reopened from Recents after Android closed the app: the system hands over the old intent again.
        // The file was already opened then (unsaved work comes back as a draft), so it is not opened twice.
        boolean fromHistory = launchIntent != null && (launchIntent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
        if (launchIntent == null || fromHistory || !isFileIntent(launchIntent)) {
            call.resolve(new JSObject());
            return;
        }
        final Intent intent = launchIntent;
        io.execute(() -> {
            try {
                List<JSObject> files = readIntent(intent);
                call.resolve(files.isEmpty() ? new JSObject() : files.get(0));
                // Several files shared at once: the others arrive as fileOpened events.
                for (int i = 1; i < files.size(); i++) {
                    notifyListeners(EVENT_FILE_OPENED, files.get(i), true);
                }
            } catch (Throwable e) {
                call.reject("Could not read the launch file: " + e.getMessage(), asException(e));
            }
        });
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) {
            return;
        }
        // BridgeActivity replays the launching intent through onNewIntent() right after the bridge
        // starts. That one is delivered through getLaunchFile() instead, so skip it here.
        Activity activity = getActivity();
        if (activity != null && intent == activity.getIntent()) {
            return;
        }
        if (!isFileIntent(intent)) {
            return;
        }
        io.execute(() -> {
            try {
                for (JSObject file : readIntent(intent)) {
                    // retainUntilConsumed: delivered later if the web app has not subscribed yet.
                    notifyListeners(EVENT_FILE_OPENED, file, true);
                }
            } catch (Throwable e) {
                // Throwable: a file too large for memory must not take the app down.
                Log.e(TAG, "Could not read incoming file", e);
            }
        });
    }

    private static boolean isFileIntent(Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) || Intent.ACTION_EDIT.equals(action)) {
            return intent.getData() != null;
        }
        if (Intent.ACTION_SEND.equals(action)) {
            return streamExtra(intent) != null || intent.getCharSequenceExtra(Intent.EXTRA_TEXT) != null;
        }
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            return !streamExtras(intent).isEmpty();
        }
        return false;
    }

    /** The files an "Open with" / "Edit with" / "Share to" intent carries, in order (several for ACTION_SEND_MULTIPLE). */
    private List<JSObject> readIntent(Intent intent) throws IOException {
        List<JSObject> out = new ArrayList<>();
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) || Intent.ACTION_EDIT.equals(action)) {
            if (intent.getData() != null) {
                uris.add(intent.getData());
            }
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = streamExtra(intent);
            if (uri != null) {
                uris.add(uri);
            } else {
                // Plain text shared without a file: hand it over as a .txt file (opens as text import) (no uri).
                CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (text == null) {
                    return out;
                }
                String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                String base = subject != null && !subject.trim().isEmpty() ? sanitizeFileName(subject.trim()) : "Shared text";
                JSObject ret = new JSObject();
                ret.put("name", base + ".txt");
                ret.put("mime", "text/plain");
                ret.put("data", Base64.encodeToString(text.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
                out.add(ret);
                return out;
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            uris.addAll(streamExtras(intent));
        }
        IOException first = null;
        for (Uri uri : uris) {
            if (!isAllowedUri(uri)) {
                Log.w(TAG, "Ignored a file address that is not a content: URI of another app");
                continue;
            }
            try {
                takePersistablePermission(uri);
                // The intent's type describes a single file; with several, each is identified on its own.
                out.add(readDocument(uri, uris.size() == 1 ? intent.getType() : null));
            } catch (IOException e) {
                Log.w(TAG, "Could not read " + uri, e);
                if (first == null) {
                    first = e;
                }
            }
        }
        if (out.isEmpty() && first != null) {
            throw first;
        }
        return out;
    }

    private static Uri streamExtra(Intent intent) {
        Uri uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        if (uri == null) {
            ClipData clip = intent.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                uri = clip.getItemAt(0).getUri();
            }
        }
        return uri;
    }

    private static List<Uri> streamExtras(Intent intent) {
        List<Uri> out = new ArrayList<>();
        ArrayList<Uri> list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
        if (list != null) {
            for (Uri uri : list) {
                if (uri != null) {
                    out.add(uri);
                }
            }
        }
        if (out.isEmpty()) {
            ClipData clip = intent.getClipData();
            for (int i = 0; clip != null && i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) {
                    out.add(uri);
                }
            }
        }
        return out;
    }

    /**
     * Only content: URIs served by another app's provider are read or written. A file: URI, or a URI of this
     * app's own file provider, can name a file in the app's private storage: a crafted "Open with" intent would
     * make the app show it, and Save would then overwrite it.
     */
    private boolean isAllowedUri(Uri uri) {
        if (uri == null || !ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            return false;
        }
        String host = uri.getHost();
        return host != null && !host.equals(getContext().getPackageName() + ".fileprovider");
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    private JSObject readDocument(Uri uri, String hintMime) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        String name = queryDisplayName(uri);
        if (name == null || name.isEmpty()) {
            name = "Untitled";
        }
        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        ret.put("name", name);
        ret.put("mime", resolveMime(resolver, uri, name, hintMime));
        // Streamed to a cache file that the page fetches: the contents never cross the bridge as a string.
        File dir = new File(getContext().getCacheDir(), OPENED_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("Cannot create " + dir.getAbsolutePath());
        }
        File copy = new File(dir, UUID.randomUUID().toString() + ".bin");
        long size;
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) {
                throw new IOException("Unable to open " + uri);
            }
            size = copyToFile(in, copy, MAX_READ_BYTES);
        }
        ret.put("path", copy.getAbsolutePath());
        ret.put("size", size);
        return ret;
    }

    /** Writes the page's payload: base64 {@code data}, or the staged file {@code path} (streamed, then deleted). */
    private void writePayload(Uri uri, String data, String staged) throws IOException {
        if (staged == null) {
            writeBytes(uri, decodeBase64(data));
            return;
        }
        File src = cacheChild(OUTGOING_DIR, staged);
        if (src == null || !src.isFile()) {
            throw new IOException("The file to save is missing");
        }
        try (InputStream in = new FileInputStream(src); OutputStream out = openForWriting(uri)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            out.flush();
        } finally {
            deleteStaged(staged);
        }
    }

    /**
     * The file {@code path} names (an absolute path or a file: URL) when it lies directly in cache/{@code dir}/,
     * else null: the page cannot make the plugin read, write or delete anything else.
     */
    private File cacheChild(String dir, String path) {
        if (path == null || path.isEmpty()) {
            return null;
        }
        try {
            String p = path.startsWith("file:") ? Uri.parse(path).getPath() : path;
            if (p == null) {
                return null;
            }
            File f = new File(p).getCanonicalFile();
            File parent = new File(getContext().getCacheDir(), dir).getCanonicalFile();
            return parent.equals(f.getParentFile()) ? f : null;
        } catch (IOException e) {
            return null;
        }
    }

    private void deleteStaged(String path) {
        File f = cacheChild(OUTGOING_DIR, path);
        if (f != null && f.isFile() && !f.delete()) {
            Log.w(TAG, "Could not delete " + f.getName());
        }
    }

    /** Copies a stream to a file, at most {@code max} bytes; a partial copy is deleted. Returns the size. */
    private static long copyToFile(InputStream in, File dest, long max) throws IOException {
        long total = 0;
        boolean ok = false;
        try (OutputStream out = new FileOutputStream(dest)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > max) {
                    throw new IOException("The file is larger than " + (max / (1024 * 1024)) + " MB, the most Anne's Folio opens on Android");
                }
                out.write(buffer, 0, read);
            }
            ok = true;
        } finally {
            if (!ok && !dest.delete()) {
                Log.w(TAG, "Could not delete the partial copy " + dest.getName());
            }
        }
        return total;
    }

    private static void deleteFilesIn(File dir) {
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        for (File f : files) {
            if (f.isFile() && !f.delete()) {
                Log.w(TAG, "Could not delete " + f.getName());
            }
        }
    }

    private void writeBytes(Uri uri, byte[] bytes) throws IOException {
        try (OutputStream out = openForWriting(uri)) {
            out.write(bytes);
            out.flush();
        }
    }

    private OutputStream openForWriting(Uri uri) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        OutputStream stream = null;
        try {
            // "wt" truncates; not every provider supports it, so fall back to "w".
            stream = resolver.openOutputStream(uri, "wt");
        } catch (Exception e) {
            Log.w(TAG, "openOutputStream(\"wt\") failed, retrying with \"w\": " + e.getMessage());
        }
        if (stream == null) {
            stream = resolver.openOutputStream(uri, "w");
        }
        if (stream == null) {
            throw new IOException("Unable to open " + uri + " for writing");
        }
        return stream;
    }

    private String queryDisplayName(Uri uri) {
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (
                Cursor cursor = getContext()
                    .getContentResolver()
                    .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)
            ) {
                if (cursor != null && cursor.moveToFirst()) {
                    int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (index >= 0 && !cursor.isNull(index)) {
                        String name = cursor.getString(index);
                        if (name != null && !name.isEmpty()) {
                            return name;
                        }
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not query display name for " + uri, e);
            }
        }
        String last = uri.getLastPathSegment();
        if (last == null) {
            return null;
        }
        int slash = last.lastIndexOf('/');
        return slash >= 0 ? last.substring(slash + 1) : last;
    }

    private static String resolveMime(ContentResolver resolver, Uri uri, String name, String hintMime) {
        String mime = null;
        try {
            mime = resolver.getType(uri);
        } catch (Exception ignored) {
            // Some providers throw for unknown URIs; fall through to the other strategies.
        }
        if (isSpecificMime(mime)) {
            return mime;
        }
        if (isSpecificMime(hintMime)) {
            return hintMime;
        }
        String fromExtension = mimeFromExtension(name);
        if (fromExtension != null) {
            return fromExtension;
        }
        return mime != null ? mime : "application/octet-stream";
    }

    private static boolean isSpecificMime(String mime) {
        return mime != null && !mime.isEmpty() && !"application/octet-stream".equals(mime) && !mime.contains("*");
    }

    private static String mimeFromExtension(String name) {
        if (name == null) {
            return null;
        }
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            return null;
        }
        String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (ext) {
            case "pdf":
                return "application/pdf";
            case "fdf":
                return "application/vnd.fdf";
            case "xfdf":
                return "application/vnd.adobe.xfdf";
            case "qfr":
                return "application/x-quillfolio-review";
            case "png":
                return "image/png";
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "gif":
                return "image/gif";
            case "webp":
                return "image/webp";
            case "bmp":
                return "image/bmp";
            case "tif":
            case "tiff":
                return "image/tiff";
            case "svg":
                return "image/svg+xml";
            case "md":
            case "markdown":
                return "text/markdown";
            case "txt":
                return "text/plain";
            case "html":
            case "htm":
                return "text/html";
            case "json":
                return "application/json";
            case "zip":
                return "application/zip";
            case "docx":
                return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            case "odt":
                return "application/vnd.oasis.opendocument.text";
            case "pptx":
                return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
            case "odp":
                return "application/vnd.oasis.opendocument.presentation";
            case "xlsx":
                return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            case "ods":
                return "application/vnd.oasis.opendocument.spreadsheet";
            case "csv":
                return "text/csv";
            default:
                return null;
        }
    }

    private void takePersistablePermission(Uri uri) {
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            return;
        }
        ContentResolver resolver = getContext().getContentResolver();
        try {
            resolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            );
        } catch (Exception e) {
            try {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
                // Not a persistable grant (e.g. a one-off VIEW intent); access lasts for this session.
            }
        }
    }

    private static Uri resultUri(ActivityResult result) {
        if (result == null || result.getResultCode() != Activity.RESULT_OK) {
            return null;
        }
        Intent data = result.getData();
        return data != null ? data.getData() : null;
    }

    private static Exception asException(Throwable t) {
        return t instanceof Exception ? (Exception) t : new Exception(t.toString(), t);
    }

    private static void resolveCanceled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("canceled", true);
        call.resolve(ret);
    }

    private static byte[] decodeBase64(String data) {
        if (data == null) {
            return new byte[0];
        }
        // Tolerate a data: URL prefix ("data:<mime>;base64,....").
        int comma = data.startsWith("data:") ? data.indexOf(',') : -1;
        String payload = comma >= 0 ? data.substring(comma + 1) : data;
        return Base64.decode(payload, Base64.DEFAULT);
    }

    private static String[] toStringArray(JSArray array) {
        List<String> out = new ArrayList<>();
        if (array != null) {
            for (int i = 0; i < array.length(); i++) {
                Object value = array.opt(i);
                if (value instanceof String && !((String) value).isEmpty()) {
                    out.add((String) value);
                }
            }
        }
        return out.toArray(new String[0]);
    }

    private static String sanitizeFileName(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (cleaned.isEmpty() || ".".equals(cleaned) || "..".equals(cleaned)) {
            return "document";
        }
        return cleaned;
    }

    private static void pruneOldShares(File dir) {
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        long cutoff = System.currentTimeMillis() - SHARE_FILE_MAX_AGE_MS;
        for (File f : files) {
            if (f.isFile() && f.lastModified() < cutoff && !f.delete()) {
                Log.w(TAG, "Could not delete old shared file " + f.getName());
            }
        }
    }
}
