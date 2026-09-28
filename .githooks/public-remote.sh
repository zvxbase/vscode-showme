# 公開 repo（zvxbase/vscode-showme）の URL かを決める。**フックと publish の道具はこれ1つを読む。**
#
# org の接頭辞（zvxbase/）では決めない。同じ org に private の開発 repo を置くと、そちらまで公開の
# 検査の対象になり、逆に `zvxbase/vscode-showme-dev` のような名前を公開 repo と取り違える。
# repo の名前まで完全に一致したときだけ真（末尾の .git と / は許す）。ssh の利用者名は `*` で書く ――
# 利用者名つきの綴りをそのまま書くと、公開ツリーの走査がメールアドレスと読む。
is_public_remote() {
  case "${1:-}" in
    https://github.com/zvxbase/vscode-showme | https://github.com/zvxbase/vscode-showme.git | \
    https://github.com/zvxbase/vscode-showme/ | \
    *@github.com:zvxbase/vscode-showme | *@github.com:zvxbase/vscode-showme.git | \
    ssh://*@github.com/zvxbase/vscode-showme | ssh://*@github.com/zvxbase/vscode-showme.git)
      return 0 ;;
    *) return 1 ;;
  esac
}
