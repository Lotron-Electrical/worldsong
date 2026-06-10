// Worldsong — native Android/iOS shell.
//
// The whole app is a full-screen WebView pointing at the live Worldsong site.
// The web app (generative Web Audio engine, canvas visualizer, voting, suburb
// logic) runs unchanged inside the WebView. The only thing the native layer adds
// is *better location*: it asks for permission, then streams high-accuracy GPS
// straight into the page via window.__worldsongFeedPosition(lat, lon). We set
// window.__NATIVE_GPS = true before the page loads so the web app defers to us
// instead of using the WebView's weaker built-in geolocation.

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { StyleSheet, View, Text, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';

const SITE_URL = 'https://worldsong.onrender.com';
const PRE_INJECT = 'window.__NATIVE_GPS = true; true;';

export default function App() {
  useKeepAwake(); // keep the screen on while the music plays

  const webRef = useRef(null);
  const watchRef = useRef(null);
  const lastPosRef = useRef(null);   // most recent {lat, lon} we've seen
  const pageReadyRef = useRef(false); // has the web page told us it's listening?
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  // Push a coordinate into the web app (and remember it so we can re-send later).
  const feed = useCallback((lat, lon) => {
    lastPosRef.current = { lat, lon };
    if (!webRef.current) return;
    webRef.current.injectJavaScript(
      `window.__worldsongFeedPosition && window.__worldsongFeedPosition(${lat}, ${lon}); true;`,
    );
  }, []);

  // Re-send the last known fix — used when the page finishes loading or signals
  // that its position hook is now installed (covers the race where the first GPS
  // fix lands before the WebView has defined window.__worldsongFeedPosition).
  const flush = useCallback(() => {
    const p = lastPosRef.current;
    if (p) feed(p.lat, p.lon);
  }, [feed]);

  useEffect(() => {
    let mounted = true;
    let bridge = null;
    (async () => {
      try {
        const enabled = await Location.hasServicesEnabledAsync();
        if (!enabled) {
          setError('Location (GPS) is turned off on your phone. Switch it on in your settings, then reopen Worldsong.');
          return;
        }
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setError('Location permission is needed so the music can match where you are. Enable it in Settings and reopen Worldsong.');
          return;
        }

        // Fast initial fix so the first song loads quickly…
        try {
          const first = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          if (mounted) feed(first.coords.latitude, first.coords.longitude);
        } catch { /* the watcher below will catch up */ }

        // …then stream updates. distanceInterval: 0 means we keep getting fixes on
        // a timer even when you're standing still (a parked car, a red light, the
        // couch) — the old 25 m filter meant a stationary phone never updated at all.
        watchRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 0, timeInterval: 3000 },
          (pos) => { if (mounted) feed(pos.coords.latitude, pos.coords.longitude); },
        );

        // Bridge the load race: re-push the latest fix every 2s for the first ~24s,
        // until the page confirms it's listening. After that the watcher carries it.
        let ticks = 0;
        bridge = setInterval(() => {
          ticks += 1;
          if (pageReadyRef.current || ticks > 12) { clearInterval(bridge); bridge = null; return; }
          flush();
        }, 2000);
      } catch (e) {
        setError(String((e && e.message) || e));
      }
    })();
    return () => {
      mounted = false;
      if (watchRef.current) watchRef.current.remove();
      if (bridge) clearInterval(bridge);
    };
  }, [feed, flush]);

  // The web page posts "worldsong:ready" once its position hook is installed.
  const onMessage = useCallback((e) => {
    const data = (e && e.nativeEvent && e.nativeEvent.data) || '';
    if (data.indexOf('worldsong:ready') !== -1) {
      pageReadyRef.current = true;
      flush();
    }
  }, [flush]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <WebView
        ref={webRef}
        source={{ uri: SITE_URL }}
        style={styles.web}
        injectedJavaScriptBeforeContentLoaded={PRE_INJECT}
        onLoadEnd={() => { setReady(true); flush(); }}
        onMessage={onMessage}
        onError={(e) => setError((e && e.nativeEvent && e.nativeEvent.description) || 'Could not reach Worldsong. Check your connection.')}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        javaScriptEnabled
        domStorageEnabled
        geolocationEnabled
        originWhitelist={['*']}
        onGeolocationPermissionsShowPrompt={(origin, callback) => callback && callback(origin, true, false)}
      />

      {!ready && !error && (
        <View style={styles.overlay} pointerEvents="none">
          <Text style={styles.brand}>🌍 WORLDSONG</Text>
          <ActivityIndicator color="#7c5cff" size="large" />
          <Text style={styles.sub}>tuning in to where you are…</Text>
        </View>
      )}

      {error && (
        <View style={styles.overlay}>
          <Text style={styles.brand}>🌍 WORLDSONG</Text>
          <Text style={styles.sub}>{error}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#07080f' },
  web: { flex: 1, backgroundColor: '#07080f' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#07080f',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 16,
  },
  brand: { color: '#e8ecff', fontSize: 24, fontWeight: '800', letterSpacing: 4, marginBottom: 8 },
  sub: { color: '#8b93b8', fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
