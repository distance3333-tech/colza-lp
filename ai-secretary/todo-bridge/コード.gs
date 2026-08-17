/**
 * Google ToDo リスト（Google Tasks）と AI秘書 をつなぐ窓口。
 *
 * 「サービス」の一覧に Tasks API が無いため、
 * REST API を直接呼ぶ方式にしてある（サービス追加は不要）。
 *
 * ─────────────────────────────────────────────
 * このファイルは 2026-08-09 版の置き換えです。
 * 変更点は DIAGNOSIS.md の「4. 直したこと」を参照。
 * 動作（レスポンスの形）は後方互換で、AI秘書側の
 * 既存コードを変えなくてもそのまま動きます。
 * ─────────────────────────────────────────────
 *
 * 【準備】
 *   1. 左下の歯車(プロジェクトの設定)を開く
 *      → 「appsscript.json マニフェスト ファイルをエディタで表示する」にチェック
 *   2. appsscript.json を下の内容にする:
 *
 *      {
 *        "timeZone": "Asia/Tokyo",
 *        "dependencies": {},
 *        "exceptionLogging": "STACKDRIVER",
 *        "runtimeVersion": "V8",
 *        "oauthScopes": [
 *          "https://www.googleapis.com/auth/tasks",
 *          "https://www.googleapis.com/auth/script.external_request"
 *        ],
 *        "webapp": {
 *          "executeAs": "USER_DEPLOYING",
 *          "access": "ANYONE_ANONYMOUS"
 *        }
 *      }
 *
 *   3. 下の SECRET を .env の MORNING_JOB_TOKEN と同じ値にする
 *   4. 関数リストから diagnose を選んで実行
 *      → 許可を承認 → ログに「トークンのスコープ」と「リスト名の一覧」が出る
 *
 * 【公開】
 *   右上「デプロイ」→ 新しいデプロイ → 歯車から「ウェブアプリ」を選ぶ
 *     次のユーザーとして実行: 自分
 *     アクセスできるユーザー: 全員
 *   → 発行されたURLを控える
 *
 *   ★ コードを直したら「新しいデプロイ」を作り直すこと。
 *     既存デプロイは古いコードのまま動き続けます。
 *
 *   「全員」に見えるが、下の合言葉がないと何も返さないので他人は使えない。
 */

const SECRET = '<<< 元のスクリプトの SECRET をここに貼る >>>';

const API = 'https://tasks.googleapis.com/tasks/v1';

// ---- Google ToDo を直接呼ぶ ----------------------------------------------

function api(path, method, payload) {
  const options = {
    method: method || 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  const res = UrlFetchApp.fetch(API + path, options);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) {
    // 本文を切り詰めずに err に持たせる。握りつぶす側で全部ログに出すため。
    const err = new Error('Tasks API ' + code + ': ' + text.slice(0, 500));
    err.httpStatus = code;
    err.httpBody = text;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// ---- 秘書からの呼び出し口 -------------------------------------------------

function doPost(e) {
  let req = {};

  try {
    req = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    console.error('doPost: リクエストのJSONが壊れています: ' + parseErr);
    return json({ ok: false, error: 'bad_request', detail: String(parseErr) });
  }

  if (req.secret !== SECRET) {
    console.warn('doPost: 合言葉が一致しません (action=' + req.action + ')');
    return json({ ok: false, error: 'unauthorized' });
  }

  try {
    switch (req.action) {
      case 'lists':
        return json({ ok: true, lists: getLists() });

      case 'items': {
        const result = getItems(req.list);
        if (!result) return listNotFound(req.list, 'items');
        return json({ ok: true, items: result });
      }

      case 'add': {
        const result = addItem(req.list, req.title);
        if (!result) return listNotFound(req.list, 'add');
        return json({ ok: true, added: result });
      }

      case 'complete': {
        const result = completeItem(req.list, req.title);
        if (!result) {
          // リストが無いのか、その名前の項目が無いのかを分けて返す
          if (!findList(req.list)) return listNotFound(req.list, 'complete');
          console.warn('complete: 項目が見つかりません title="' + req.title + '"');
          return json({ ok: false, error: 'item_not_found', requested: req.title || null, completed: null });
        }
        return json({ ok: true, completed: result });
      }

      default:
        console.warn('doPost: 知らない action="' + req.action + '"');
        return json({ ok: false, error: 'unknown action', requested: req.action || null });
    }
  } catch (err) {
    // ここが今回の肝。以前は握りつぶして 200 で返していたため、
    // 実行ログ上は「完了」に見えて何が起きたか分からなかった。
    console.error(
      [
        'doPost 失敗',
        '  action    = ' + req.action,
        '  list      = ' + req.list,
        '  message   = ' + (err && err.message),
        '  httpStatus= ' + (err && err.httpStatus),
        '  httpBody  = ' + (err && err.httpBody),
        '  stack     = ' + (err && err.stack),
      ].join('\n'),
    );
    return json({
      ok: false,
      error: (err && err.message) || String(err),
      httpStatus: (err && err.httpStatus) || null,
      httpBody: err && err.httpBody ? String(err.httpBody).slice(0, 500) : null,
    });
  }
}

/** リストが見つからないときは、実在するリスト名を添えて返す */
function listNotFound(requested, action) {
  let available = [];
  try {
    available = getLists().map(function (l) {
      return l.title;
    });
  } catch (err) {
    console.error('リスト一覧の取得にも失敗: ' + err.message + ' / httpBody=' + err.httpBody);
  }
  console.warn(
    'list_not_found (action=' + action + ') 要求="' + requested + '" 実在=' + JSON.stringify(available),
  );
  return json({
    ok: false,
    error: 'list_not_found',
    requested: requested || null,
    available: available,
    items: null,
  });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

// ---- ToDoリストの操作 -----------------------------------------------------

/** リストの一覧(「仕事」「買い物リスト」など) */
function getLists() {
  const res = api('/users/@me/lists?maxResults=50');
  return (res.items || []).map(function (l) {
    return { id: l.id, title: l.title };
  });
}

/** リスト名から中身を取る。名前は部分一致でよい */
function getItems(listName) {
  const list = findList(listName);
  if (!list) return null;

  const res = api('/lists/' + list.id + '/tasks?maxResults=100&showCompleted=false');
  return {
    list: list.title,
    items: (res.items || []).map(function (t) {
      return { title: t.title, due: t.due || null };
    }),
  };
}

function addItem(listName, title) {
  const list = findList(listName);
  if (!list) return null;
  api('/lists/' + list.id + '/tasks', 'post', { title: title });
  return { list: list.title, title: title };
}

/** 同じ名前の項目を完了にする */
function completeItem(listName, title) {
  const list = findList(listName);
  if (!list) return null;

  const res = api('/lists/' + list.id + '/tasks?maxResults=100&showCompleted=false');
  const target = (res.items || []).filter(function (t) {
    // 題名の無い項目が混ざると indexOf で落ちるので String() で守る
    const t2 = String(t.title || '');
    return t2 === title || t2.indexOf(title) >= 0;
  })[0];
  if (!target) return null;

  api('/lists/' + list.id + '/tasks/' + target.id, 'patch', { status: 'completed' });
  return { list: list.title, title: target.title };
}

/** 名前でリストを探す。完全一致 → 部分一致 → 最初のリスト の順 */
function findList(name) {
  const lists = getLists();
  if (!name) return lists[0] || null;

  const exact = lists.filter(function (l) {
    return l.title === name;
  })[0];
  if (exact) return exact;

  const partial = lists.filter(function (l) {
    return l.title.indexOf(name) >= 0 || name.indexOf(l.title) >= 0;
  })[0];
  if (partial) {
    console.log('findList: "' + name + '" を部分一致で "' + partial.title + '" に解決しました');
    return partial;
  }

  return null;
}

// ---- 動作確認用 -----------------------------------------------------------

/** 最初に実行する。許可を出して、リストが取れるか確かめる */
function testRun() {
  const lists = getLists();
  Logger.log('リスト一覧: ' + JSON.stringify(lists));
  if (lists.length) {
    Logger.log('中身の例: ' + JSON.stringify(getItems(lists[0].title)));
  }
}

/**
 * つながらないときはこれを実行する。
 * トークンのスコープと有効期限、実在するリスト名、失敗時の生の応答を全部ログに出す。
 */
function diagnose() {
  const out = ['=== ToDo連携 自己診断 ==='];

  // 1) トークンそのもの（スコープと有効期限）
  try {
    const token = ScriptApp.getOAuthToken();
    out.push('OAuthトークン取得: OK (長さ ' + token.length + ')');
    const info = UrlFetchApp.fetch(
      'https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true },
    );
    out.push('tokeninfo HTTP ' + info.getResponseCode());
    out.push('tokeninfo: ' + info.getContentText().slice(0, 600));
    out.push('  ↑ scope に .../auth/tasks が無ければ権限不足。承認をやり直すこと。');
    out.push('  ↑ expires_in は「今取ったトークンの残り秒数」。数千秒なら正常。');
  } catch (err) {
    out.push('OAuthトークンの確認で失敗: ' + err);
  }

  // 2) リストが実際に取れるか
  try {
    const lists = getLists();
    out.push('リスト取得: OK / ' + lists.length + '件');
    lists.forEach(function (l) {
      out.push('  - "' + l.title + '"');
    });
    out.push('  ↑ 秘書が投げている list 名がこの中に無ければ list_not_found になる。');
  } catch (err) {
    out.push('リスト取得で失敗: ' + err.message);
    out.push('  httpStatus = ' + err.httpStatus);
    out.push('  httpBody   = ' + err.httpBody);
  }

  const text = out.join('\n');
  console.log(text);
  return text;
}

/** 秘書が投げている名前が、どのリストに解決されるか確かめる */
function checkListName(name) {
  const target = name || 'ToDoリスト';
  const hit = findList(target);
  const msg = hit
    ? '"' + target + '" → "' + hit.title + '" に解決されました'
    : '"' + target + '" に一致するリストがありません。diagnose() で実在するリスト名を確認してください。';
  console.log(msg);
  return msg;
}
