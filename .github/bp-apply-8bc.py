# kolo 8bc: jednorazovy patch - aplikuje opravu cest CHMU obrazku pres proxy
# (chybel prefix /meteorology/weather/radar/). ASCII-only transport.
# Po aplikaci: node tools/build.cjs + testy + md5 kotvy v CI workflow.
import hashlib, sys

OLD = "  return BP_PROXY ? BP_PROXY + \"/chmi/img?u=\" + encodeURIComponent(path)\u000a                  : CHMI_BASE + path;"
NEW = "  /* Worker vy\u017eaduje celou host-relativn\u00ed cestu pod /meteorology/weather/radar/\u000a     (kolo 8bc: bez prefixu worker vr\u00e1til 400 a \u010cHM\u00da modul se ml\u010dky vypnul). */\u000a  return BP_PROXY ? BP_PROXY + \"/chmi/img?u=\" + encodeURIComponent(\"/meteorology/weather/radar\" + path)\u000a                  : CHMI_BASE + path;"
EXPECT_MAIN_MD5 = "17efc59b7199c5af7ea36b565bb7a1b7"

s = open("src/main.js", encoding="utf-8").read()
n = s.count(OLD)
if n != 1:
    sys.exit("CHYBA: vzor nalezen %dx (ocekavano 1x) - soubor jiz patchovan?" % n)
s = s.replace(OLD, NEW)
open("src/main.js", "w", encoding="utf-8", newline="").write(s)
md5 = hashlib.md5(open("src/main.js", "rb").read()).hexdigest()
if md5 != EXPECT_MAIN_MD5:
    sys.exit("CHYBA: md5 po patchi = %s, ocekavano %s" % (md5, EXPECT_MAIN_MD5))
print("PATCH OK: src/main.js md5 =", md5)
