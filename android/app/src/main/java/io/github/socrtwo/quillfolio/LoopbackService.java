package io.github.socrtwo.quillfolio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps Anne's Folio in the foreground state while the OAuth loopback listener waits for the browser.
 * Android 14+ freezes cached (background) apps, and a frozen app cannot answer the browser's redirect.
 * On Android 14+ this is a {@code shortService} (no permission beyond FOREGROUND_SERVICE, about three
 * minutes allowed: {@link #onTimeout} stops it); on older versions a plain foreground service.
 * Started by {@link QuillNativePlugin#startLoopback}; stopped when the redirect arrives, on cancel and on timeout.
 * The listener itself runs in the plugin; this service only shows the notification.
 */
public class LoopbackService extends Service {

    private static final String TAG = "QuillNative";
    private static final String CHANNEL_ID = "quillfolio.signin";
    private static final int NOTIFICATION_ID = 7101;

    /** False once stop() was called; checked again after startForeground, so a stop that came first still wins. */
    private static volatile boolean wanted;
    /** The running instance; touched on the main thread only. */
    private static LoopbackService running;

    static void start(Context context) {
        wanted = true;
        Context app = context.getApplicationContext();
        try {
            ContextCompat.startForegroundService(app, new Intent(app, LoopbackService.class));
        } catch (Throwable e) {
            // E.g. ForegroundServiceStartNotAllowedException: sign-in still works while the app is not frozen.
            wanted = false;
            Log.w(TAG, "Could not start the sign-in service", e);
        }
    }

    static void stop() {
        wanted = false;
        // Not stopService(): stopping before onStartCommand called startForeground crashes some Android versions.
        new Handler(Looper.getMainLooper()).post(() -> {
            if (running != null) {
                running.finish();
            }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        running = this;
        try {
            Notification n = notification();
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Throwable e) {
            Log.w(TAG, "Could not show the sign-in notification", e);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!wanted) {
            finish();
        }
        return START_NOT_STICKY;
    }

    /** Android 14: the time allowed to a short service is up. */
    @Override
    public void onTimeout(int startId) {
        finish();
    }

    /** Android 15+. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        finish();
    }

    @Override
    public void onDestroy() {
        if (running == this) {
            running = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void finish() {
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private Notification notification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Sign-in", NotificationManager.IMPORTANCE_LOW);
                channel.setDescription("Shown while Anne's Folio waits for a sign-in in the browser.");
                nm.createNotificationChannel(channel);
            }
        }
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_signin)
            .setContentTitle("Waiting for sign-in")
            .setContentText("Anne's Folio is waiting for the browser to finish signing you in.")
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true);
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) {
            b.setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        return b.build();
    }
}
