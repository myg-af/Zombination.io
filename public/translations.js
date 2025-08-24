const TRANSLATIONS = {
  en: {
    login: 'Log in',
    signup: 'Sign up',
    signout: 'Sign out',
    settings: 'Settings',
    username: 'Username',
    password: 'Password',
    confirmPassword: 'Confirm your password',
    currentPassword: 'Current password',
    newPassword: 'New password',
    changePassword: 'Change password',
    cancel: 'Cancel',
    submit: 'Submit',
    userExists: 'Username already taken.',
    weakPassword: 'Password too weak (min 6).',
    invalidCredentials: 'Invalid username or password.',
    signupOk: 'Account created. You can log in now.',
    loginOk: 'Logged in.',
    logoutOk: 'Signed out.',
    pwdChanged: 'Password changed. Please log in again.',
    fillAll: 'Please fill all fields.',
    reservedName: 'This nickname is reserved by an account. Choose another one.',
    pseudoTaken: 'Nickname already in use.',
    send: 'Send',
    chatPlaceholder: 'Message (max 50)',
    chat: 'Chat',
    lobbyChat: 'Lobby chat',
    worldChat: 'World chat',
    zombination: "Zombination.io",
    join: 'Solo',
    joinAction: 'Join',
    waiting: "Waiting...",
    enterPseudo: "Enter your nickname",
    playersInGame: "Players in game",
    playersReady: "ready",
    timeLeft: "Time left",
    waitingStart: "Waiting for game start...",
    alive: "Players alive",
    zombiesLeft: "Active zombies",
    kills: "Zombies killed",
    round: "Wave",
    health: "Health",
    replay: "Replay",
    youDied: "You died!",
    zombiesKilled: "Zombies killed",
    roundReached: "Wave reached",
  
    shop: 'Upgrades',
    joinLobby: 'Join lobby',
    createLobby: 'Create lobby',
    start: 'Start',
    back: 'Back',
    availableLobbies: 'Available lobbies',
    lobby: 'Lobby',
    onlyCreatorStart: 'Only the creator can start.',
    noLobbyAvailable: 'No lobby available.',
    emptySlot: 'empty',
    spectate: 'Spectate',
    buildWall: 'Wall',
    buildDoor: 'Door',
    buildMiniTurret: 'Mini-T',
    buildTurret: 'Turret',
    money: 'Money',
    turretDescMini: 'Improves damage of mini turrets.',
    turretDescNormal: 'Improves damage of normal turrets.',
    turretDescBig: 'Improves damage of big turrets.',
    damage: 'Damage',
    turretType: { t: 'mini turret', T: 'turret', G: 'big turret' },
    turretUpgradeSuccess: 'Upgrade {type} lvl {level} succeeded. Money: ${money}',
    notEnoughMoney: 'Not enough money.',
    actionImpossible: 'Action impossible.',
    upgrades: { maxHp: { label: '+10% Max HP', desc: 'Increase max HP.', statLabel: 'Max HP' }, speed: { label: '+7% Move speed', desc: 'Move faster.', statLabel: 'Speed' }, regen: { label: '+0.05 HP/s', desc: 'Regenerate health over time.', statLabel: 'Regen' }, damage: { label: '+10% Damage', desc: 'Increase your weapon damage.', statLabel: 'Damage' }, goldGain: { label: '+10% Money earned', desc: 'Earn more gold per kill.', statLabel: 'Gold gain' } },
  },
  cn: {
    login: '登录',
    signup: '注册',
    signout: '退出',
    settings: '设置',
    username: '用户名',
    password: '密码',
    confirmPassword: '确认密码',
    currentPassword: '当前密码',
    newPassword: '新密码',
    changePassword: '修改密码',
    cancel: '取消',
    submit: '提交',
    userExists: '用户名已被占用。',
    weakPassword: '密码太弱（至少6位）。',
    invalidCredentials: '用户名或密码错误。',
    signupOk: '账号已创建。现在可以登录。',
    loginOk: '已登录。',
    logoutOk: '已退出。',
    pwdChanged: '密码已修改，请重新登录。',
    fillAll: '请填写所有字段。',
    reservedName: '该昵称已被账户保留。请换一个。',
    pseudoTaken: '昵称已被使用。',
    send: '发送',
    chatPlaceholder: '消息（最多50）',
    chat: '聊天',
    lobbyChat: '大厅聊天',
    worldChat: '世界聊天',
    zombination: "Zombination.io",
    join: '单人',
    joinAction: '加入',
    waiting: "等待中...",
    enterPseudo: "输入昵称",
    playersInGame: "游戏玩家",
    playersReady: "已准备",
    timeLeft: "剩余时间",
    waitingStart: "等待游戏开始...",
    alive: "存活玩家",
    zombiesLeft: "活跃僵尸",
    kills: "击杀僵尸",
    round: "波次",
    health: "生命值",
    replay: "再来一次",
    youDied: "你死了！",
    zombiesKilled: "击杀僵尸",
    roundReached: "达到波次",
  
    shop: '升级',
    joinLobby: '加入房间',
    createLobby: '创建房间',
    start: '开始',
    back: '返回',
    availableLobbies: '可用房间',
    lobby: '房间',
    onlyCreatorStart: '只有创建者可以开始。',
    noLobbyAvailable: '暂无可用房间。',
    emptySlot: '空位',
    spectate: '旁观',
    buildWall: '墙',
    buildDoor: '门',
    buildMiniTurret: '小型炮台',
    buildTurret: '炮台',
    money: '金钱',
    turretDescMini: '提升小型炮台的伤害。',
    turretDescNormal: '提升普通炮台的伤害。',
    turretDescBig: '提升大型炮台的伤害。',
    damage: '伤害',
    turretType: { t: '小型炮台', T: '炮台', G: '大型炮台' },
    turretUpgradeSuccess: '升级 {type} 等级 {level} 成功。金钱: ${money}',
    notEnoughMoney: '金钱不足。',
    actionImpossible: '无法执行操作。',
    upgrades: { maxHp: { label: '+10% 生命上限', desc: '提高最大生命值。', statLabel: '生命上限' }, speed: { label: '+7% 移动速度', desc: '移动更快。', statLabel: '移动速度' }, regen: { label: '+0.05 生命/秒', desc: '随时间恢复生命。', statLabel: '生命回复' }, damage: { label: '+10% 伤害', desc: '提高你的武器伤害。', statLabel: '伤害' }, goldGain: { label: '+10% 金钱获得', desc: '每次击杀获得更多金币。', statLabel: '金币获取' } },
  },
  ru: {
    login: 'Войти',
    signup: 'Регистрация',
    signout: 'Выйти',
    settings: 'Настройки',
    username: 'Имя пользователя',
    password: 'Пароль',
    confirmPassword: 'Подтвердите пароль',
    currentPassword: 'Текущий пароль',
    newPassword: 'Новый пароль',
    changePassword: 'Сменить пароль',
    cancel: 'Отмена',
    submit: 'Отправить',
    userExists: 'Имя уже занято.',
    weakPassword: 'Пароль слишком простой (мин. 6).',
    invalidCredentials: 'Неверный логин или пароль.',
    signupOk: 'Аккаунт создан. Можно войти.',
    loginOk: 'Вход выполнен.',
    logoutOk: 'Вы вышли.',
    pwdChanged: 'Пароль изменён. Войдите снова.',
    fillAll: 'Заполните все поля.',
    reservedName: 'Этот ник занят зарегистрированным аккаунтом. Выберите другой.',
    pseudoTaken: 'Ник уже занят.',
    send: 'Отправить',
    chatPlaceholder: 'Сообщение (макс. 50)',
    chat: 'Чат',
    lobbyChat: 'Чат лобби',
    worldChat: 'Мировой чат',
    zombination: "Zombination.io",
    join: 'Соло',
    joinAction: 'Присоединиться',
    waiting: "Ожидание...",
    enterPseudo: "Введите ник",
    playersInGame: "Игроков в игре",
    playersReady: "готов",
    timeLeft: "Осталось времени",
    waitingStart: "Ожидание начала игры...",
    alive: "Живые игроки",
    zombiesLeft: "Активные зомби",
    kills: "Убито зомби",
    round: "Волна",
    health: "Здоровье",
    replay: "Повторить",
    youDied: "Вы умерли!",
    zombiesKilled: "Убито зомби",
    roundReached: "Достигнута волна",
  
    shop: 'Улучшения',
    joinLobby: 'Присоединиться к лобби',
    createLobby: 'Создать лобби',
    start: 'Старт',
    back: 'Назад',
    availableLobbies: 'Доступные лобби',
    lobby: 'Лобби',
    onlyCreatorStart: 'Только создатель может начать.',
    noLobbyAvailable: 'Нет доступных лобби.',
    emptySlot: 'пусто',
    spectate: 'Наблюдать',
    buildWall: 'Стена',
    buildDoor: 'Дверь',
    buildMiniTurret: 'Мини‑Т',
    buildTurret: 'Турель',
    money: 'Деньги',
    turretDescMini: 'Улучшает урон мини‑турелей.',
    turretDescNormal: 'Улучшает урон обычных турелей.',
    turretDescBig: 'Улучшает урон больших турелей.',
    damage: 'Урон',
    turretType: { t: 'мини‑турель', T: 'турель', G: 'большая турель' },
    turretUpgradeSuccess: 'Улучшение {type} ур. {level} выполнено. Деньги: ${money}',
    notEnoughMoney: 'Недостаточно денег.',
    actionImpossible: 'Действие невозможно.',
    upgrades: { maxHp: { label: '+10% Макс. HP', desc: 'Увеличивает максимальный запас HP.', statLabel: 'Макс. HP' }, speed: { label: '+7% Скорость', desc: 'Двигайтесь быстрее.', statLabel: 'Скорость' }, regen: { label: '+0,05 HP/с', desc: 'Постепенное восстановление здоровья.', statLabel: 'Регенерация' }, damage: { label: '+10% Урон', desc: 'Повышает ваш урон.', statLabel: 'Урон' }, goldGain: { label: '+10% Заработанных денег', desc: 'Больше золота за убийства.', statLabel: 'Золото' } },
  },
  es: {
    login: 'Iniciar sesión',
    signup: 'Registrarse',
    signout: 'Cerrar sesión',
    settings: 'Ajustes',
    username: 'Usuario',
    password: 'Contraseña',
    confirmPassword: 'Confirmar contraseña',
    currentPassword: 'Contraseña actual',
    newPassword: 'Nueva contraseña',
    changePassword: 'Cambiar contraseña',
    cancel: 'Cancelar',
    submit: 'Enviar',
    userExists: 'Usuario ya existe.',
    weakPassword: 'Contraseña débil (mín. 6).',
    invalidCredentials: 'Usuario o contraseña inválidos.',
    signupOk: 'Cuenta creada. Ya puedes iniciar sesión.',
    loginOk: 'Conectado.',
    logoutOk: 'Sesión cerrada.',
    pwdChanged: 'Contraseña cambiada. Inicia sesión de nuevo.',
    fillAll: 'Rellena todos los campos.',
    reservedName: 'Este apodo está reservado por una cuenta. Elige otro.',
    zombination: "Zombination.io",
    join: 'Solo',
    joinAction: 'Unirse',
    waiting: "Esperando...",
    enterPseudo: "Introduce tu apodo",
    playersInGame: "Jugadores en la partida",
    playersReady: "listo",
    timeLeft: "Tiempo restante",
    waitingStart: "Esperando a que inicie la partida...",
    alive: "Jugadores vivos",
    zombiesLeft: "Zombies activos",
    kills: "Zombies eliminados",
    round: "Oleada",
    health: "Vida",
    replay: "Repetir",
    youDied: "¡Has muerto!",
    zombiesKilled: "Zombies eliminados",
    roundReached: "Oleada alcanzada",
  
    shop: 'Mejoras',
    joinLobby: 'Unirse a un lobby',
    createLobby: 'Crear lobby',
    start: 'Iniciar',
    back: 'Atrás',
    availableLobbies: 'Lobbies disponibles',
    lobby: 'Lobby',
    onlyCreatorStart: 'Solo el creador puede iniciar.',
    noLobbyAvailable: 'No hay lobbys disponibles.',
    emptySlot: 'vacío',
    spectate: 'Observar',
    buildWall: 'Muro',
    buildDoor: 'Puerta',
    buildMiniTurret: 'Mini‑T',
    buildTurret: 'Torreta',
    money: 'Dinero',
    turretDescMini: 'Mejora el daño de las torretas mini.',
    turretDescNormal: 'Mejora el daño de las torretas normales.',
    turretDescBig: 'Mejora el daño de las torretas grandes.',
    damage: 'Daño',
    turretType: { t: 'minitorreta', T: 'torreta', G: 'torreta grande' },
    turretUpgradeSuccess: 'Mejora {type} niv {level} completada. Dinero: ${money}',
    notEnoughMoney: 'No hay suficiente dinero.',
    actionImpossible: 'Acción imposible.',
    upgrades: { maxHp: { label: '+10% Vida máx', desc: 'Aumenta la vida máxima.', statLabel: 'Vida máx' }, speed: { label: '+7% Velocidad', desc: 'Te mueves más rápido.', statLabel: 'Velocidad' }, regen: { label: '+0,05 PS/s', desc: 'Regeneras vida con el tiempo.', statLabel: 'Regeneración' }, damage: { label: '+10% Daño', desc: 'Aumenta tu daño.', statLabel: 'Daño' }, goldGain: { label: '+10% Dinero ganado', desc: 'Gana más oro por baja.', statLabel: 'Oro ganado' } },
  },
  pt: {
    login: 'Entrar',
    signup: 'Criar conta',
    signout: 'Sair',
    settings: 'Configurações',
    username: 'Usuário',
    password: 'Senha',
    confirmPassword: 'Confirmar senha',
    currentPassword: 'Senha atual',
    newPassword: 'Nova senha',
    changePassword: 'Alterar senha',
    cancel: 'Cancelar',
    submit: 'Enviar',
    userExists: 'Nome de usuário já existe.',
    weakPassword: 'Senha fraca (mín. 6).',
    invalidCredentials: 'Usuário ou senha inválidos.',
    signupOk: 'Conta criada. Você pode entrar.',
    loginOk: 'Conectado.',
    logoutOk: 'Desconectado.',
    pwdChanged: 'Senha alterada. Entre novamente.',
    fillAll: 'Preencha todos os campos.',
    reservedName: 'Este apelido está reservado por uma conta. Escolha outro.',
    pseudoTaken: 'Apelido já em uso.',
    send: 'Enviar',
    chatPlaceholder: 'Mensagem (máx. 50)',
    chat: 'Chat',
    lobbyChat: 'Chat do lobby',
    worldChat: 'Chat global',
    zombination: "Zombination.io",
    join: 'Solo',
    joinAction: 'Entrar',
    waiting: "Aguardando...",
    enterPseudo: "Digite seu apelido",
    playersInGame: "Jogadores na partida",
    playersReady: "pronto",
    timeLeft: "Tempo restante",
    waitingStart: "Aguardando início da partida...",
    alive: "Jogadores vivos",
    zombiesLeft: "Zumbis ativos",
    kills: "Zumbis mortos",
    round: "Onda",
    health: "Vida",
    replay: "Repetir",
    youDied: "Você morreu!",
    zombiesKilled: "Zumbis mortos",
    roundReached: "Onda alcançada",
  
    shop: 'Melhorias',
    joinLobby: 'Entrar no lobby',
    createLobby: 'Criar lobby',
    start: 'Iniciar',
    back: 'Voltar',
    availableLobbies: 'Lobbies disponíveis',
    lobby: 'Lobby',
    onlyCreatorStart: 'Apenas o criador pode iniciar.',
    noLobbyAvailable: 'Nenhum lobby disponível.',
    emptySlot: 'vazio',
    spectate: 'Assistir',
    buildWall: 'Muro',
    buildDoor: 'Porta',
    buildMiniTurret: 'Mini‑T',
    buildTurret: 'Torreta',
    money: 'Dinheiro',
    turretDescMini: 'Melhora o dano das mini torretas.',
    turretDescNormal: 'Melhora o dano das torretas normais.',
    turretDescBig: 'Melhora o dano das torretas grandes.',
    damage: 'Dano',
    turretType: { t: 'mini torreta', T: 'torreta', G: 'torreta grande' },
    turretUpgradeSuccess: 'Upgrade {type} nv {level} concluído. Dinheiro: ${money}',
    notEnoughMoney: 'Dinheiro insuficiente.',
    actionImpossible: 'Ação impossível.',
    upgrades: { maxHp: { label: '+10% Vida máx', desc: 'Aumenta a vida máxima.', statLabel: 'Vida máx' }, speed: { label: '+7% Velocidade', desc: 'Move-se mais rápido.', statLabel: 'Velocidade' }, regen: { label: '+0,05 PV/s', desc: 'Regenera vida com o tempo.', statLabel: 'Regeneração' }, damage: { label: '+10% Dano', desc: 'Aumenta seu dano.', statLabel: 'Dano' }, goldGain: { label: '+10% Dinheiro ganho', desc: 'Ganhe mais ouro por abate.', statLabel: 'Ouro ganho' } },
  },
  de: {
    login: 'Anmelden',
    signup: 'Registrieren',
    signout: 'Abmelden',
    settings: 'Einstellungen',
    username: 'Benutzername',
    password: 'Passwort',
    confirmPassword: 'Passwort bestätigen',
    currentPassword: 'Aktuelles Passwort',
    newPassword: 'Neues Passwort',
    changePassword: 'Passwort ändern',
    cancel: 'Abbrechen',
    submit: 'Senden',
    userExists: 'Benutzername bereits vergeben.',
    weakPassword: 'Passwort zu schwach (min. 6).',
    invalidCredentials: 'Ungültige Anmeldedaten.',
    signupOk: 'Konto erstellt. Jetzt anmelden.',
    loginOk: 'Angemeldet.',
    logoutOk: 'Abgemeldet.',
    pwdChanged: 'Passwort geändert. Bitte erneut anmelden.',
    fillAll: 'Bitte alle Felder ausfüllen.',
    reservedName: 'Dieser Nickname ist durch ein Konto reserviert. Bitte wähle einen anderen.',
    pseudoTaken: 'Spitzname bereits vergeben.',
    send: 'Senden',
    chatPlaceholder: 'Nachricht (max. 50)',
    chat: 'Chat',
    lobbyChat: 'Lobby-Chat',
    worldChat: 'Weltchat',
    zombination: "Zombination.io",
    join: 'Solo',
    joinAction: 'Beitreten',
    waiting: "Warten...",
    enterPseudo: "Spitznamen eingeben",
    playersInGame: "Spieler im Spiel",
    playersReady: "bereit",
    timeLeft: "Verbleibende Zeit",
    waitingStart: "Warten auf Spielstart...",
    alive: "Lebende Spieler",
    zombiesLeft: "Aktive Zombies",
    kills: "Getötete Zombies",
    round: "Welle",
    health: "Leben",
    replay: "Wiederholen",
    youDied: "Du bist gestorben!",
    zombiesKilled: "Getötete Zombies",
    roundReached: "Welle erreicht",
  
    shop: 'Verbesserungen',
    joinLobby: 'Lobby beitreten',
    createLobby: 'Lobby erstellen',
    start: 'Starten',
    back: 'Zurück',
    availableLobbies: 'Verfügbare Lobbys',
    lobby: 'Lobby',
    onlyCreatorStart: 'Nur der Ersteller kann starten.',
    noLobbyAvailable: 'Kein Lobby verfügbar.',
    emptySlot: 'leer',
    spectate: 'Zuschauen',
    buildWall: 'Mauer',
    buildDoor: 'Tür',
    buildMiniTurret: 'Mini‑T',
    buildTurret: 'Geschütz',
    money: 'Geld',
    turretDescMini: 'Verbessert den Schaden von Mini‑Geschützen.',
    turretDescNormal: 'Verbessert den Schaden normaler Geschütze.',
    turretDescBig: 'Verbessert den Schaden großer Geschütze.',
    damage: 'Schaden',
    turretType: { t: 'Mini‑Geschütz', T: 'Geschütz', G: 'Großes Geschütz' },
    turretUpgradeSuccess: 'Upgrade {type} Stufe {level} erfolgreich. Geld: ${money}',
    notEnoughMoney: 'Nicht genug Geld.',
    actionImpossible: 'Aktion nicht möglich.',
    upgrades: { maxHp: { label: '+10% Max. HP', desc: 'Erhöht die max. HP.', statLabel: 'Max. HP' }, speed: { label: '+7% Geschwindigkeit', desc: 'Bewege dich schneller.', statLabel: 'Geschwindigkeit' }, regen: { label: '+0,05 HP/s', desc: 'Regeneriert HP über Zeit.', statLabel: 'Regeneration' }, damage: { label: '+10% Schaden', desc: 'Erhöht deinen Schaden.', statLabel: 'Schaden' }, goldGain: { label: '+10% Verdientes Geld', desc: 'Mehr Gold pro Kill.', statLabel: 'Goldgewinn' } },
  },
  jp: {
    login: 'ログイン',
    signup: 'サインアップ',
    signout: 'ログアウト',
    settings: '設定',
    username: 'ユーザー名',
    password: 'パスワード',
    confirmPassword: 'パスワード確認',
    currentPassword: '現在のパスワード',
    newPassword: '新しいパスワード',
    changePassword: 'パスワードを変更',
    cancel: 'キャンセル',
    submit: '送信',
    userExists: 'ユーザー名は既に使われています。',
    weakPassword: 'パスワードが弱すぎます（6文字以上）。',
    invalidCredentials: 'ユーザー名またはパスワードが無効です。',
    signupOk: 'アカウント作成完了。ログインしてください。',
    loginOk: 'ログインしました。',
    logoutOk: 'ログアウトしました。',
    pwdChanged: 'パスワード変更完了。再度ログインしてください。',
    fillAll: 'すべての項目を入力してください。',
    reservedName: 'このニックネームはアカウントによって予約済みです。別のものを選んでください。',
    pseudoTaken: 'そのニックネームは使用中です。',
    send: '送信',
    chatPlaceholder: 'メッセージ（最大50）',
    chat: 'チャット',
    lobbyChat: 'ロビーチャット',
    worldChat: 'ワールドチャット',
    zombination: "Zombination.io",
    join: 'ソロ',
    joinAction: '参加',
    waiting: "待機中...",
    enterPseudo: "ニックネームを入力",
    playersInGame: "ゲームのプレイヤー",
    playersReady: "準備完了",
    timeLeft: "残り時間",
    waitingStart: "ゲーム開始を待っています...",
    alive: "生存者",
    zombiesLeft: "アクティブなゾンビ",
    kills: "倒したゾンビ",
    round: "ウェーブ",
    health: "体力",
    replay: "リプレイ",
    youDied: "あなたは死亡しました！",
    zombiesKilled: "倒したゾンビ",
    roundReached: "ウェーブ達成",
  
    shop: 'アップグレード',
    joinLobby: 'ロビーに参加',
    createLobby: 'ロビーを作成',
    start: '開始',
    back: '戻る',
    availableLobbies: '利用可能なロビー',
    lobby: 'ロビー',
    onlyCreatorStart: '作成者のみが開始できます。',
    noLobbyAvailable: '利用可能なロビーはありません。',
    emptySlot: '空き',
    spectate: '観戦',
    buildWall: '壁',
    buildDoor: 'ドア',
    buildMiniTurret: 'ミニT',
    buildTurret: 'タレット',
    money: 'お金',
    turretDescMini: 'ミニタレットのダメージを強化します。',
    turretDescNormal: '通常タレットのダメージを強化します。',
    turretDescBig: '大型タレットのダメージを強化します。',
    damage: 'ダメージ',
    turretType: { t: 'ミニタレット', T: 'タレット', G: '大型タレット' },
    turretUpgradeSuccess: '{type} Lv{level} の強化に成功。お金: ${money}',
    notEnoughMoney: 'お金が足りません。',
    actionImpossible: '操作できません。',
    upgrades: { maxHp: { label: '+10% 最大HP', desc: '最大HPを増やす。', statLabel: '最大HP' }, speed: { label: '+7% 移動速度', desc: '移動が速くなる。', statLabel: '移動速度' }, regen: { label: '+0.05 HP/秒', desc: '時間とともに回復。', statLabel: '回復' }, damage: { label: '+10% ダメージ', desc: '与ダメージを増やす。', statLabel: 'ダメージ' }, goldGain: { label: '+10% 獲得金額', desc: 'キル毎のゴールド増加。', statLabel: 'ゴールド獲得' } },
  },
  fr: {
    login: 'Se connecter',
    signup: 'Créer un compte',
    signout: 'Se déconnecter',
    settings: 'Paramètres',
    username: 'Nom d\'utilisateur',
    password: 'Mot de passe',
    confirmPassword: 'Confirmez le mot de passe',
    currentPassword: 'Mot de passe actuel',
    newPassword: 'Nouveau mot de passe',
    changePassword: 'Changer le mot de passe',
    cancel: 'Annuler',
    submit: 'Valider',
    userExists: 'Nom déjà utilisé.',
    weakPassword: 'Mot de passe trop faible (min 6).',
    invalidCredentials: 'Identifiants invalides.',
    signupOk: 'Compte créé. Vous pouvez vous connecter.',
    loginOk: 'Connecté.',
    logoutOk: 'Déconnecté.',
    pwdChanged: 'Mot de passe modifié. Merci de vous reconnecter.',
    fillAll: 'Veuillez remplir tous les champs.',
    reservedName: 'Ce pseudo est réservé par un compte. Choisissez-en un autre.',
    pseudoTaken: 'Pseudo déjà utilisé.',
    send: 'Envoyer',
    chatPlaceholder: 'Message (max 50)',
    chat: 'Chat',
    lobbyChat: 'Chat du lobby',
    worldChat: 'Chat global',
    zombination: "Zombination.io",
    join: 'Solo',
    joinAction: 'Rejoindre',
    waiting: "En attente...",
    enterPseudo: "Entrez votre pseudo",
    playersInGame: "Joueurs dans la partie",
    playersReady: "prêt",
    timeLeft: "Temps restant",
    waitingStart: "Partie en attente de démarrage...",
    alive: "Joueurs en vie",
    zombiesLeft: "Zombies actifs",
    kills: "Zombies tués",
    round: "Vague",
    health: "Vie",
    replay: "Rejouer",
    youDied: "Vous êtes mort !",
    zombiesKilled: "Zombies tués",
    roundReached: "Vague atteinte",
  
    shop: 'Améliorations',
    joinLobby: 'Rejoindre un lobby',
    createLobby: 'Créer un lobby',
    start: 'Démarrer',
    back: 'Retour',
    availableLobbies: 'Lobbys disponibles',
    lobby: 'Lobby',
    onlyCreatorStart: 'Seul le créateur peut démarrer.',
    noLobbyAvailable: 'Aucun lobby disponible.',
    emptySlot: 'vide',
    spectate: 'Observer',
    buildWall: 'Mur',
    buildDoor: 'Porte',
    buildMiniTurret: 'Mini-T',
    buildTurret: 'Tourelle',
    money: 'Argent',
    turretDescMini: 'Améliore les dégâts des mini‑tourelles.',
    turretDescNormal: 'Améliore les dégâts des tourelles normales.',
    turretDescBig: 'Améliore les dégâts des grosses tourelles.',
    damage: 'Dégâts',
    turretType: { t: 'mini‑tourelle', T: 'tourelle', G: 'grosse tourelle' },
    turretUpgradeSuccess: 'Amélioration {type} niv {level} réussie. Argent: ${money}',
    notEnoughMoney: 'Pas assez d\'argent.',
    actionImpossible: 'Action impossible.',
    upgrades: { maxHp: { label: '+10% PV max', desc: 'Augmente les PV max.', statLabel: 'PV max' }, speed: { label: '+7% Vitesse', desc: 'Augmente la vitesse.', statLabel: 'Vitesse' }, regen: { label: '+0,05 PV/s', desc: 'Régénère des PV.', statLabel: 'Régénération' }, damage: { label: '+10% Dégâts', desc: 'Augmente vos dégâts.', statLabel: 'Dégâts' }, goldGain: { label: '+10% d\'Argent gagné', desc: 'Gagnez plus d\'or par kill.', statLabel: 'Gain d\'or' } },
  },
  pl: {
    login: 'Zaloguj się',
    signup: 'Zarejestruj się',
    signout: 'Wyloguj',
    settings: 'Ustawienia',
    username: 'Nazwa użytkownika',
    password: 'Hasło',
    confirmPassword: 'Potwierdź hasło',
    currentPassword: 'Obecne hasło',
    newPassword: 'Nowe hasło',
    changePassword: 'Zmień hasło',
    cancel: 'Anuluj',
    submit: 'Wyślij',
    userExists: 'Nazwa zajęta.',
    weakPassword: 'Hasło zbyt słabe (min. 6).',
    invalidCredentials: 'Nieprawidłowy login lub hasło.',
    signupOk: 'Konto utworzone. Zaloguj się.',
    loginOk: 'Zalogowano.',
    logoutOk: 'Wylogowano.',
    pwdChanged: 'Hasło zmienione. Zaloguj się ponownie.',
    fillAll: 'Wypełnij wszystkie pola.',
    reservedName: 'Ten nick jest zarezerwowany przez konto. Wybierz inny.',
    pseudoTaken: 'Pseudonim jest już zajęty.',
    send: 'Wyślij',
    chatPlaceholder: 'Wiadomość (max 50)',
    chat: 'Czat',
    lobbyChat: 'Czat lobby',
    worldChat: 'Czat globalny',
    zombination: "Zombination.io",
    join: 'Solo',
    joinAction: 'Dołącz',
    waiting: "Oczekiwanie...",
    enterPseudo: "Wpisz pseudonim",
    playersInGame: "Gracze w grze",
    playersReady: "gotowy",
    timeLeft: "Pozostały czas",
    waitingStart: "Oczekiwanie na rozpoczęcie gry...",
    alive: "Gracze żywi",
    zombiesLeft: "Aktywne zombie",
    kills: "Zabite zombie",
    round: "Fala",
    health: "Zdrowie",
    replay: "Powtórz",
    youDied: "Zginąłeś!",
    zombiesKilled: "Zabite zombie",
    roundReached: "Fala osiągnięta",
  
    shop: 'Ulepszenia',
    joinLobby: 'Dołącz do lobby',
    createLobby: 'Utwórz lobby',
    start: 'Start',
    back: 'Wstecz',
    availableLobbies: 'Dostępne lobby',
    lobby: 'Lobby',
    onlyCreatorStart: 'Tylko twórca może rozpocząć.',
    noLobbyAvailable: 'Brak dostępnych lobby.',
    emptySlot: 'puste',
    spectate: 'Obserwuj',
    buildWall: 'Mur',
    buildDoor: 'Drzwi',
    buildMiniTurret: 'Mini‑T',
    buildTurret: 'Wieżyczka',
    money: 'Pieniądze',
    turretDescMini: 'Zwiększa obrażenia mini‑wieżyczek.',
    turretDescNormal: 'Zwiększa obrażenia zwykłych wieżyczek.',
    turretDescBig: 'Zwiększa obrażenia dużych wieżyczek.',
    damage: 'Obrażenia',
    turretType: { t: 'mini‑wieżyczka', T: 'wieżyczka', G: 'duża wieżyczka' },
    turretUpgradeSuccess: 'Ulepszono {type} do poziomu {level}. Pieniądze: ${money}',
    notEnoughMoney: 'Za mało pieniędzy.',
    actionImpossible: 'Akcja niemożliwa.',
    upgrades: { maxHp: { label: '+10% Maks. HP', desc: 'Zwiększa maksymalne HP.', statLabel: 'Maks. HP' }, speed: { label: '+7% Szybkość', desc: 'Poruszasz się szybciej.', statLabel: 'Szybkość' }, regen: { label: '+0,05 HP/s', desc: 'Regeneracja zdrowia.', statLabel: 'Regeneracja' }, damage: { label: '+10% Obrażenia', desc: 'Zwiększa obrażenia.', statLabel: 'Obrażenia' }, goldGain: { label: '+10% Zdobytych pieniędzy', desc: 'Więcej złota za zabójstwa.', statLabel: 'Złoto' } },
  },
  kr: {
    login: '로그인',
    signup: '회원가입',
    signout: '로그아웃',
    settings: '설정',
    username: '사용자명',
    password: '비밀번호',
    confirmPassword: '비밀번호 확인',
    currentPassword: '현재 비밀번호',
    newPassword: '새 비밀번호',
    changePassword: '비밀번호 변경',
    cancel: '취소',
    submit: '확인',
    userExists: '사용자명이 이미 존재합니다.',
    weakPassword: '비밀번호가 약합니다(최소 6자).',
    invalidCredentials: '잘못된 사용자명 또는 비밀번호.',
    signupOk: '계정이 생성되었습니다. 이제 로그인하세요.',
    loginOk: '로그인되었습니다.',
    logoutOk: '로그아웃되었습니다.',
    pwdChanged: '비밀번호가 변경되었습니다. 다시 로그인하세요.',
    fillAll: '모든 칸을 입력하세요.',
    reservedName: '이 닉네임은 계정에서 사용 중입니다. 다른 닉네임을 선택하세요.',
    pseudoTaken: '닉네임이 이미 사용 중입니다.',
    send: '보내기',
    chatPlaceholder: '메시지(최대 50자)',
    chat: '채팅',
    lobbyChat: '로비 채팅',
    worldChat: '월드 채팅',
    zombination: "Zombination.io",
    join: '솔로',
    joinAction: '참가',
    waiting: "대기 중...",
    enterPseudo: "닉네임 입력",
    playersInGame: "게임의 플레이어",
    playersReady: "준비됨",
    timeLeft: "남은 시간",
    waitingStart: "게임 시작 대기 중...",
    alive: "생존자",
    zombiesLeft: "활성 좀비",
    kills: "처치한 좀비",
    round: "웨이브",
    health: "체력",
    replay: "재시작",
    youDied: "사망하였습니다!",
    zombiesKilled: "처치한 좀비",
    roundReached: "웨이브 도달",
  
    shop: '업그레이드',
    joinLobby: '로비 참가',
    createLobby: '로비 생성',
    start: '시작',
    back: '뒤로',
    availableLobbies: '이용 가능한 로비',
    lobby: '로비',
    onlyCreatorStart: '방장만 시작할 수 있습니다.',
    noLobbyAvailable: '사용 가능한 로비가 없습니다.',
    emptySlot: '비어있음',
    spectate: '관전',
    buildWall: '벽',
    buildDoor: '문',
    buildMiniTurret: '미니T',
    buildTurret: '터렛',
    money: '돈',
    turretDescMini: '미니 터렛의 대미지를 향상합니다.',
    turretDescNormal: '일반 터렛의 대미지를 향상합니다.',
    turretDescBig: '대형 터렛의 대미지를 향상합니다.',
    damage: '대미지',
    turretType: { t: '미니 터렛', T: '터렛', G: '대형 터렛' },
    turretUpgradeSuccess: '{type} 레벨 {level} 업그레이드 성공. 돈: ${money}',
    notEnoughMoney: '돈이 부족합니다.',
    actionImpossible: '작업을 수행할 수 없습니다.',
    upgrades: { maxHp: { label: '+10% 최대 HP', desc: '최대 HP 증가.', statLabel: '최대 HP' }, speed: { label: '+7% 이동 속도', desc: '더 빨리 이동.', statLabel: '이동 속도' }, regen: { label: '+0.05 HP/초', desc: '시간 경과에 따라 회복.', statLabel: '재생' }, damage: { label: '+10% 대미지', desc: '공격력 증가.', statLabel: '대미지' }, goldGain: { label: '+10% 획득 금액', desc: '처치당 더 많은 골드.', statLabel: '골드 획득' } },
  }
};

// === i18n extensions: turret upgrades, tooltips, auto-fire ===
;(function(){
  function merge(base, ext){
    if (!base) return ext;
    for (var k in ext){
      if (!ext.hasOwnProperty(k)) continue;
      if (typeof ext[k]==='object' && ext[k] && !Array.isArray(ext[k])){
        base[k] = Object.assign({}, base[k]||{}, ext[k]);
      } else {
        base[k] = ext[k];
      }
    }
    return base;
  }

  TRANSLATIONS.en = merge(TRANSLATIONS.en, {
    hpShort:'HP', fireRate:'Fire rate',
    autoFireOn:'Auto fire ON', autoFireOff:'Auto fire OFF',
    turretUpg:{ G:'Big turret +Damage', T:'Turret +Damage', t:'Mini turret +Damage' }
  });
  TRANSLATIONS.fr = merge(TRANSLATIONS.fr, {
    hpShort:'PV', fireRate:'Cadence',
    autoFireOn:'Tir auto ON', autoFireOff:'Tir auto OFF',
    turretUpg:{ G:'Grosse tourelle +Dégâts', T:'Tourelle +Dégâts', t:'Mini-tourelle +Dégâts' }
  });
  TRANSLATIONS.es = merge(TRANSLATIONS.es||{}, {
    hpShort:'HP', fireRate:'Cadencia',
    autoFireOn:'Auto-disparo ON', autoFireOff:'Auto-disparo OFF',
    turretUpg:{ G:'Torreta grande +Daño', T:'Torreta +Daño', t:'Mini torreta +Daño' }
  });
  TRANSLATIONS.pt = merge(TRANSLATIONS.pt||{}, {
    hpShort:'HP', fireRate:'Cadência',
    autoFireOn:'Tiro automático ON', autoFireOff:'Tiro automático OFF',
    turretUpg:{ G:'Torreta grande +Dano', T:'Torreta +Dano', t:'Mini torreta +Dano' }
  });
  TRANSLATIONS.de = merge(TRANSLATIONS.de||{}, {
    hpShort:'LP', fireRate:'Feuerrate',
    autoFireOn:'Auto-Feuer AN', autoFireOff:'Auto-Feuer AUS',
    turretUpg:{ G:'Große Geschütz +Schaden', T:'Geschütz +Schaden', t:'Mini-Geschütz +Schaden' }
  });
  TRANSLATIONS.ru = merge(TRANSLATIONS.ru||{}, {
    hpShort:'HP', fireRate:'Скорострельность',
    autoFireOn:'Автоогонь ВКЛ', autoFireOff:'Автоогонь ВЫКЛ',
    turretUpg:{ G:'Большая турель +Урон', T:'Турель +Урон', t:'Мини-турель +Урон' }
  });
  TRANSLATIONS.cn = merge(TRANSLATIONS.cn||{}, {
    hpShort:'生命值', fireRate:'射速',
    autoFireOn:'自动射击 开', autoFireOff:'自动射击 关',
    turretUpg:{ G:'大型炮塔 +伤害', T:'炮塔 +伤害', t:'迷你炮塔 +伤害' }
  });
  TRANSLATIONS.jp = merge(TRANSLATIONS.jp||{}, {
    hpShort:'HP', fireRate:'連射速度',
    autoFireOn:'オート射撃 ON', autoFireOff:'オート射撃 OFF',
    turretUpg:{ G:'大型タレット ダメージ+', T:'タレット ダメージ+', t:'ミニタレット ダメージ+' }
  });
  TRANSLATIONS.pl = merge(TRANSLATIONS.pl||{}, {
    hpShort:'HP', fireRate:'Szybkostrzelność',
    autoFireOn:'Auto-ogień WŁ', autoFireOff:'Auto-ogień WYŁ',
    turretUpg:{ G:'Duża wieżyczka +obrażenia', T:'Wieżyczka +obrażenia', t:'Mini wieżyczka +obrażenia' }
  });
  TRANSLATIONS.kr = merge(TRANSLATIONS.kr||{}, {
    hpShort:'체력', fireRate:'발사 속도',
    autoFireOn:'자동 사격 ON', autoFireOff:'자동 사격 OFF',
    turretUpg:{ G:'대형 포탑 피해+', T:'포탑 피해+', t:'미니 포탑 피해+' }
  });
})();

// === i18n unit additions (perSec, pxPerSec, hpShort tweaks) ===
;(function(){
  function merge(base, ext){ if (!base) return ext; for (var k in ext){ if (ext.hasOwnProperty(k)) { if (typeof ext[k]==='object' && ext[k] && !Array.isArray(ext[k])) base[k] = Object.assign({}, base[k]||{}, ext[k]); else base[k]=ext[k]; } } return base; }
TRANSLATIONS.en = merge(TRANSLATIONS.en||{}, {
  hpShort:'HP', perSec:'/s', pxPerSec:'px/s',
  rotateToPortrait: "Rotate your device to portrait.", });
TRANSLATIONS.fr = merge(TRANSLATIONS.fr||{}, {
  hpShort:'PV', perSec:'/s', pxPerSec:'px/s',
  rotateToPortrait: "Tournez votre appareil en mode portrait.", });
TRANSLATIONS.es = merge(TRANSLATIONS.es||{}, {
  hpShort:'PS', perSec:'/s', pxPerSec:'px/s',
  rotateToPortrait: "Gira tu dispositivo a modo vertical.", });
TRANSLATIONS.pt = merge(TRANSLATIONS.pt||{}, {
  hpShort:'PV', perSec:'/s', pxPerSec:'px/s',
  rotateToPortrait: "Gire seu dispositivo para o modo retrato.", });
TRANSLATIONS.de = merge(TRANSLATIONS.de||{}, {
  hpShort:'LP', perSec:'/s', pxPerSec:'px/s',
  rotateToPortrait: "Drehen Sie Ihr Gerät ins Hochformat.", });
TRANSLATIONS.ru = merge(TRANSLATIONS.ru||{}, {
  hpShort:'HP', perSec:'/с', pxPerSec:'px/с',
  rotateToPortrait: "Поверните устройство в портретный режим.", });
TRANSLATIONS.cn = merge(TRANSLATIONS.cn||{}, {
  hpShort:'生命', perSec:'/秒', pxPerSec:'px/秒',
  rotateToPortrait: "请将设备旋转到竖屏模式。", });
TRANSLATIONS.jp = merge(TRANSLATIONS.jp||{}, {
  hpShort:'HP', perSec:'/秒', pxPerSec:'px/秒',
  rotateToPortrait: "端末を縦向きに回転してください。", });
TRANSLATIONS.pl = merge(TRANSLATIONS.pl||{}, {
  hpShort:'HP', perSec:'/s', pxPerSec:'px/s',
  rotateToPortrait: "Obróć urządzenie do trybu pionowego.", });
TRANSLATIONS.kr = merge(TRANSLATIONS.kr||{}, {
  hpShort:'HP', perSec:'/초', pxPerSec:'px/초',
  rotateToPortrait: "기기를 세로 모드로 전환하세요.", });

// Ensure availability on window for legacy code paths
try { if (typeof window !== 'undefined') { window.TRANSLATIONS = TRANSLATIONS; } } catch(_) {}
})();

;(function(){
  if (typeof window === 'undefined' || !window.TRANSLATIONS) return;
  var T = window.TRANSLATIONS;
  function add(lang, obj){ try{ T[lang] = Object.assign({}, T[lang]||{}, obj); }catch(_){ } }
  add('en', { kick: 'Kick', kickedMsg: 'You were kicked. You can rejoin in ~{s}s.' });
  add('fr', { kick: 'Exclure', kickedMsg: 'Vous avez été exclu. Vous pourrez revenir dans ~{s}s.' });
  add('es', { kick: 'Expulsar', kickedMsg: 'Has sido expulsado. Podrás volver en ~{s}s.' });
  add('pt', { kick: 'Expulsar', kickedMsg: 'Você foi expulso. Você poderá voltar em ~{s}s.' });
  add('de', { kick: 'Rauswerfen', kickedMsg: 'Du wurdest rausgeworfen. Du kannst in ~{s}s wieder beitreten.' });
  add('ru', { kick: 'Выгнать', kickedMsg: 'Вас выгнали. Вы сможете вернуться через ~{s} с.' });
  add('cn', { kick: '踢出', kickedMsg: '你已被踢出。约 ~{s} 秒后可重新加入。' });
  add('jp', { kick: 'キック', kickedMsg: 'キックされました。約 {s} 秒後に再参加できます。' });
  add('pl', { kick: 'Wyrzuć', kickedMsg: 'Zostałeś wyrzucony. Możesz dołączyć ponownie za około {s}s.' });
  add('kr', { kick: '추방', kickedMsg: '추방되었습니다. 약 {s}초 후에 다시 참여할 수 있습니다.' });
})();


// === Ladder translations injection (safe extender) ===
(function(){
  if (typeof TRANSLATIONS !== 'object') return;
  function add(lang, kv){
    TRANSLATIONS[lang] = Object.assign({}, TRANSLATIONS[lang]||{}, kv);
  }
  add('en', { ladder:'Ladder', ladderTitle:'Top 100 — Ladder', rank:'Rank', player:'Player', noData:'No data' });
  add('fr', { ladder:'Classement', ladderTitle:'Top 100 — Classement', rank:'Rang', player:'Joueur', noData:'Aucune donnée' });
  add('es', { ladder:'Clasificación', ladderTitle:'Top 100 — Clasificación', rank:'Puesto', player:'Jugador', noData:'Sin datos' });
  add('pt', { ladder:'Ranking', ladderTitle:'Top 100 — Ranking', rank:'Posição', player:'Jogador', noData:'Sem dados' });
  add('de', { ladder:'Bestenliste', ladderTitle:'Top 100 — Bestenliste', rank:'Rang', player:'Spieler', noData:'Keine Daten' });
  add('ru', { ladder:'Ладдер', ladderTitle:'Топ‑100 — Ладдер', rank:'Место', player:'Игрок', noData:'Нет данных' });
  add('cn', { ladder:'排行榜', ladderTitle:'前100名 — 排行榜', rank:'名次', player:'玩家', noData:'暂无数据' });
  add('jp', { ladder:'ランキング', ladderTitle:'トップ100 — ランキング', rank:'順位', player:'プレイヤー', noData:'データなし' });
  add('pl', { ladder:'Tabela', ladderTitle:'Top 100 — Tabela', rank:'Miejsce', player:'Gracz', noData:'Brak danych' });
  add('kr', { ladder:'랭킹', ladderTitle:'Top 100 — 랭킹', rank:'순위', player:'플레이어', noData:'데이터 없음' });
})();


// === Ladder column translations (ensure all 10 langs) ===
(function(){
  if (typeof TRANSLATIONS !== 'object') return;
  function add(lang, kv){
    TRANSLATIONS[lang] = Object.assign({}, TRANSLATIONS[lang]||{}, kv);
  }
  add('en', { rank:'Rank', player:'Player', roundReached:'Wave reached', zombiesKilled:'Zombies killed' });
  add('fr', { rank:'Rang', player:'Joueur', roundReached:'Vague atteinte', zombiesKilled:'Zombies tués' });
  add('es', { rank:'Puesto', player:'Jugador', roundReached:'Oleada alcanzada', zombiesKilled:'Zombis eliminados' });
  add('pt', { rank:'Posição', player:'Jogador', roundReached:'Onda alcançada', zombiesKilled:'Zumbis mortos' });
  add('de', { rank:'Rang', player:'Spieler', roundReached:'Erreichte Welle', zombiesKilled:'Getötete Zombies' });
  add('ru', { rank:'Место', player:'Игрок', roundReached:'Достигнутая волна', zombiesKilled:'Убито зомби' });
  add('cn', { rank:'名次', player:'玩家', roundReached:'达到波次', zombiesKilled:'击杀僵尸' });
  add('jp', { rank:'順位', player:'プレイヤー', roundReached:'到達したウェーブ', zombiesKilled:'倒したゾンビ数' });
  add('pl', { rank:'Miejsce', player:'Gracz', roundReached:'Osiągnięta fala', zombiesKilled:'Zabite zombie' });
  add('kr', { rank:'순위', player:'플레이어', roundReached:'도달한 웨이브', zombiesKilled:'처치한 좀비' });
})();

;(function(){
  try{
    var T = (typeof TRANSLATIONS === 'object' && TRANSLATIONS) || {};
    function set(lang, val){ T[lang] = Object.assign({}, T[lang]||{}); T[lang].confirmNewPassword = val; }
    set('en','Confirm your new password');
    set('fr','Confirmez votre nouveau mot de passe');
    set('es','Confirma tu nueva contraseña');
    set('pt','Confirme sua nova senha');
    set('de','Bestätigen Sie Ihr neues Passwort');
    set('ru','Подтвердите новый пароль');
    set('cn','请确认新密码');
    set('jp','新しいパスワードを確認してください');
    set('pl','Potwierdź nowe hasło');
    set('kr','새 비밀번호를 확인하세요');
  }catch(_){}
})();



// === Gold Shop translations injection ===
(function(){
  if (typeof TRANSLATIONS !== 'object') return;
  function add(lang, kv){ TRANSLATIONS[lang] = Object.assign({}, TRANSLATIONS[lang]||{}, kv); }
  add('en', {
    shopMain:'Shop', gold:'Gold', needLoginShop:'You must be logged in to access the shop.',
    hpUpgTitle:'HP +1', hpUpgDesc:'Start each game with +1 HP per level (up to +200).',
    dmgUpgTitle:'Damage +1', dmgUpgDesc:'Start each game with +1 damage per level (up to +20).',
    level:'Level', price:'Price', buy:'Buy', maxLevel:'Max level reached', notEnoughGold:'Not enough gold.',
    goldHowTo:'Earn gold by clearing waves from 5 onward: wave 5=+1, 6=+2, 7=+3, etc.'
  , purchaseOk:'Purchase successful.' });
  add('fr', {
    shopMain:'Boutique', gold:'Or', needLoginShop:'Vous devez être connecté pour accéder à la boutique.',
    hpUpgTitle:'PV +1', hpUpgDesc:'Commence chaque partie avec +1 PV par niveau (jusqu’à +200).',
    dmgUpgTitle:'Dégâts +1', dmgUpgDesc:'Commence chaque partie avec +1 dégât par niveau (jusqu’à +20).',
    level:'Niveau', price:'Prix', buy:'Acheter', maxLevel:'Niveau max atteint', notEnoughGold:'Pas assez de gold.',
    goldHowTo:'Gagne des golds à partir de la vague 5 : vague 5=+1, 6=+2, 7=+3, etc.'
  , purchaseOk:'Achat réussi.' });
  add('es', {
    shopMain:'Tienda', gold:'Oro', needLoginShop:'Debes iniciar sesión para acceder a la tienda.',
    hpUpgTitle:'HP +1', hpUpgDesc:'Empiezas cada partida con +1 HP por nivel (hasta +200).',
    dmgUpgTitle:'Daño +1', dmgUpgDesc:'Empiezas cada partida con +1 de daño por nivel (hasta +20).',
    level:'Nivel', price:'Precio', buy:'Comprar', maxLevel:'Nivel máximo alcanzado', notEnoughGold:'No hay suficiente oro.',
    goldHowTo:'Gana oro superando oleadas desde la 5: oleada 5=+1, 6=+2, 7=+3, etc.'
  , purchaseOk:'Compra realizada.' });
  add('pt', {
    shopMain:'Loja', gold:'Ouro', needLoginShop:'Você precisa estar conectado para acessar a loja.',
    hpUpgTitle:'HP +1', hpUpgDesc:'Comece cada partida com +1 HP por nível (até +200).',
    dmgUpgTitle:'Dano +1', dmgUpgDesc:'Comece cada partida com +1 de dano por nível (até +20).',
    level:'Nível', price:'Preço', buy:'Comprar', maxLevel:'Nível máximo atingido', notEnoughGold:'Ouro insuficiente.',
    goldHowTo:'Ganhe ouro ao completar ondas a partir da 5: onda 5=+1, 6=+2, 7=+3, etc.'
  , purchaseOk:'Compra concluída.' });
  add('de', {
    shopMain:'Shop', gold:'Gold', needLoginShop:'Du musst eingeloggt sein, um den Shop zu nutzen.',
    hpUpgTitle:'HP +1', hpUpgDesc:'Starte jedes Spiel mit +1 HP pro Stufe (bis +200).',
    dmgUpgTitle:'Schaden +1', dmgUpgDesc:'Starte jedes Spiel mit +1 Schaden pro Stufe (bis +20).',
    level:'Stufe', price:'Preis', buy:'Kaufen', maxLevel:'Maximalstufe erreicht', notEnoughGold:'Nicht genug Gold.',
    goldHowTo:'Verdiene Gold ab Welle 5: Welle 5=+1, 6=+2, 7=+3, usw.'
  , purchaseOk:'Kauf erfolgreich.' });
  add('ru', {
    shopMain:'Магазин', gold:'Золото', needLoginShop:'Нужно войти в аккаунт, чтобы открыть магазин.',
    hpUpgTitle:'HP +1', hpUpgDesc:'Начинайте игру с +1 HP за уровень (до +200).',
    dmgUpgTitle:'Урон +1', dmgUpgDesc:'Начинайте игру с +1 урона за уровень (до +20).',
    level:'Уровень', price:'Цена', buy:'Купить', maxLevel:'Достигнут макс. уровень', notEnoughGold:'Недостаточно золота.',
    goldHowTo:'Получайте золото с 5‑й волны: волна 5=+1, 6=+2, 7=+3 и т.д.'
  , purchaseOk:'Покупка успешна.' });
  add('cn', {
    shopMain:'商店', gold:'金币', needLoginShop:'需要登录才能进入商店。',
    hpUpgTitle:'生命值 +1', hpUpgDesc:'每级开局 +1 生命（最多 +200）。',
    dmgUpgTitle:'伤害 +1', dmgUpgDesc:'每级开局 +1 伤害（最多 +20）。',
    level:'等级', price:'价格', buy:'购买', maxLevel:'已达最高等级', notEnoughGold:'金币不足。',
    goldHowTo:'从第 5 波开始通关即可得金币：第5波+1，第6波+2，第7波+3，依此类推。'
  , purchaseOk:'购买成功。' });
  add('jp', {
    shopMain:'ショップ', gold:'ゴールド', needLoginShop:'ショップを利用するにはログインが必要です。',
    hpUpgTitle:'HP +1', hpUpgDesc:'各レベルにつき初期HP+1（最大+200）。',
    dmgUpgTitle:'ダメージ +1', dmgUpgDesc:'各レベルにつき初期ダメージ+1（最大+20）。',
    level:'レベル', price:'価格', buy:'購入', maxLevel:'最大レベルに到達', notEnoughGold:'ゴールドが足りません。',
    goldHowTo:'ウェーブ5以降をクリアしてゴールド獲得：5=+1, 6=+2, 7=+3...'
  , purchaseOk:'購入に成功しました。' });
  add('pl', {
    shopMain:'Sklep', gold:'Złoto', needLoginShop:'Musisz być zalogowany, aby wejść do sklepu.',
    hpUpgTitle:'HP +1', hpUpgDesc:'Zaczynasz grę z +1 HP na poziom (do +200).',
    dmgUpgTitle:'Obrażenia +1', dmgUpgDesc:'Zaczynasz grę z +1 obrażeniem na poziom (do +20).',
    level:'Poziom', price:'Cena', buy:'Kup', maxLevel:'Osiągnięto maks. poziom', notEnoughGold:'Za mało złota.',
    goldHowTo:'Zarabiaj złoto od fali 5: fala 5=+1, 6=+2, 7=+3 itd.'
  , purchaseOk:'Zakup udany.' });
  add('kr', {
    shopMain:'상점', gold:'골드', needLoginShop:'상점에 들어가려면 로그인해야 합니다.',
    hpUpgTitle:'HP +1', hpUpgDesc:'레벨당 시작 HP +1 (최대 +200).',
    dmgUpgTitle:'데미지 +1', dmgUpgDesc:'레벨당 시작 데미지 +1 (최대 +20).',
    level:'레벨', price:'가격', buy:'구매', maxLevel:'최대 레벨 도달', notEnoughGold:'골드가 부족합니다.',
    goldHowTo:'웨이브 5부터 클리어 시 골드 획득: 5=+1, 6=+2, 7=+3 등'
  , purchaseOk:'구매 완료되었습니다.' });
})();