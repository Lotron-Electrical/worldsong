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
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  // Push a coordinate into the web app.
  const feed = useCallback((lat, lon) => {
    if (!webRef.current) return;
    webRef.current.injectJavaScript(
      `window.__worldsongFeedPosition && window.__worldsongFeedPosition(${lat}, ${lon}); true;`,
    );
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
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

        // …then stream updates as you move (every ~25m or 4s).
        watchRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 25, timeInterval: 4000 },
          (pos) => feed(pos.coords.latitude, pos.coords.longitude),
        );
      } catch (e) {
        setError(String((e && e.message) || e));
      }
    })();
    return () => {
      mounted = false;
      if (watchRef.current) watchRef.current.remove();
    };
  }, [feed]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <WebView
        ref={webRef}
        source={{ uri: SITE_URL }}
        style={styles.web}
        injectedJavaScriptBeforeContentLoaded={PRE_INJECT}
        onLoadEnd={() => setReady(true)}
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
