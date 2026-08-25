/* 보듬 Service Worker */
var CACHE = 'bodeum-v3';
var DB_NAME = 'bodeum-notif';
var DB_STORE = 'state';

/* ── IndexedDB helpers ── */
function openDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function(e) { e.target.result.createObjectStore(DB_STORE); };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror = reject;
  });
}
function dbGet(db, key) {
  return new Promise(function(resolve, reject) {
    var req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror = reject;
  });
}
function dbPut(db, key, val) {
  return new Promise(function(resolve, reject) {
    var req = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(val, key);
    req.onsuccess = resolve;
    req.onerror = reject;
  });
}

/* ── 알림 타이머 ── */
var _hungerTimer = null;
var _hungerRepeatTimer = null;
var _feedTimer = null;
var _babyName = '아이'; // 모듈 레벨 — activate 재시작 시에도 유지 (IndexedDB에서 복원)

function elapsedLabel(ms) {
  var totalMin = Math.floor(ms / 60000);
  var hh = Math.floor(totalMin / 60), mm = totalMin % 60;
  return (hh > 0 ? hh + '시간' : '') + mm + '분';
}

function fireHungerNotif(lastFeedTime) {
  var elapsed = Date.now() - lastFeedTime;
  self.registration.showNotification('보듬 🌿', {
    body: _babyName + '가 배고플시간, 맘마 준비해주세요.\n마지막 맘마로 부터 ' + elapsedLabel(elapsed) + ' 지났어요.',
    tag: 'hunger',
    renotify: true,
    requireInteraction: false
  });
  _hungerRepeatTimer = setTimeout(function() { fireHungerNotif(lastFeedTime); }, 5 * 60 * 1000);
}

function scheduleNotifications(lastFeedTime, activeFeedStart, babyName) {
  if (babyName) _babyName = babyName;
  clearTimeout(_hungerTimer);
  clearTimeout(_hungerRepeatTimer);
  clearTimeout(_feedTimer);

  var now = Date.now();

  /* 배고픔 알림: 마지막 수유 후 2시간 30분째 1회, 이후 5분마다 반복 */
  if (lastFeedTime && !activeFeedStart) {
    var elapsed = now - lastFeedTime;
    var delay = (2.5 * 3600 * 1000) - elapsed;
    if (delay <= 0) {
      /* 이미 시간이 지남 — 6시간 이내면 즉시 알림 후 5분 반복 */
      if (elapsed < 6 * 3600 * 1000) {
        fireHungerNotif(lastFeedTime);
      }
    } else {
      _hungerTimer = setTimeout(function() { fireHungerNotif(lastFeedTime); }, delay);
    }
  }

  /* 수유 타이머 30분 경과 알림 */
  if (activeFeedStart) {
    var feedElapsed = now - activeFeedStart;
    var feedDelay = 30 * 60 * 1000 - feedElapsed;
    if (feedDelay <= 0) {
      if (feedElapsed < 90 * 60 * 1000) {
        self.registration.showNotification('보듬 🌿', {
          body: '아직 맘마중인가요? 맘마 다 먹었으면 타이머 종료해주세요.',
          tag: 'feed-timer',
          renotify: false,
          requireInteraction: false
        });
      }
    } else {
      _feedTimer = setTimeout(function() {
        self.registration.showNotification('보듬 🌿', {
          body: '아직 맘마중인가요? 맘마 다 먹었으면 타이머 종료해주세요.',
          tag: 'feed-timer',
          renotify: true,
          requireInteraction: false
        });
      }, feedDelay);
    }
  }
}

/* ── 설치 ── */
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      return c.addAll(['/bodeum/']).catch(function() {});
    })
  );
  self.skipWaiting();
});

/* ── 활성화 ── */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(ks) {
      return Promise.all(ks.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    }).then(function() {
      /* SW 재시작 시 DB에서 상태 복원 */
      return openDB().then(function(db) {
        return Promise.all([dbGet(db, 'lastFeedTime'), dbGet(db, 'activeFeedStart'), dbGet(db, 'babyName')]);
      }).then(function(vals) {
        if (vals[2]) _babyName = vals[2];
        if (vals[0] || vals[1]) scheduleNotifications(vals[0], vals[1]);
      }).catch(function() {});
    })
  );
  self.clients.claim();
});

/* ── 네트워크 캐시 ── */
self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(function(res) {
      var clone = res.clone();
      caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
      return res;
    }).catch(function() { return caches.match(e.request); })
  );
});

/* ── 메인 앱 → SW 메시지 ── */
self.addEventListener('message', function(e) {
  if (!e.data || e.data.type !== 'FEED_UPDATE') return;
  var lastFeedTime = e.data.lastFeedTime || null;
  var activeFeedStart = e.data.activeFeedStart || null;
  var babyName = e.data.babyName || '아이';

  openDB().then(function(db) {
    return Promise.all([
      dbPut(db, 'lastFeedTime', lastFeedTime),
      dbPut(db, 'activeFeedStart', activeFeedStart),
      dbPut(db, 'babyName', babyName)
    ]);
  }).catch(function() {});

  scheduleNotifications(lastFeedTime, activeFeedStart, babyName);
});

/* ── 알림 클릭 → 앱 포커스 ── */
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('/bodeum/');
    })
  );
});
