# cloudterm smoke report

Generated 2026-04-21T09:18:52.138Z on node v22.22.2.

**3 pass · 0 fail · 2 skip**

| scenario | status | duration | snapshots | bytes |
|----------|--------|----------|-----------|-------|
| basic | PASS | 1.29s | 5 | 1149 |
| vim | PASS | 1.43s | 4 | 4114 |
| less | PASS | 1.23s | 4 | 3216 |
| htop | SKIP | 8ms | 0 | 0 |
| tmux | SKIP | 5ms | 0 | 0 |

## how to read this

- Each snapshot is the raw grid dump at a labeled point in the scenario.
- `altScreen: true` means the grid reports the alternate buffer is active.
  If the field reads `false` during `vim`/`less`/`htop`, alt-screen routing
  is not wired up yet.
- Cursor row/col are 0-indexed relative to the active screen.
- `main-before-*` vs `main-after-*` snapshots diff the main buffer across
  an alt-screen excursion. If they differ unexpectedly, the main buffer was
  not preserved.

## basic — PASS (1.29s)

- bytes received from PTY: 1149
- snapshots: 5
- steps: 16

<details><summary>step trace</summary>

| # | type | label | ms | note |
|---|------|-------|----|------|
| 0 | input |  | 0 | "export PS1='>>> ' PS2='... '; clear\r" |
| 1 | waitFor | initial-prompt | 22 | />>> / -> match |
| 2 | snapshot | after-clear | 50 |  |
| 3 | input |  | 0 | "echo hello\r" |
| 4 | waitFor | echo-output | 21 | /hello/ -> match |
| 5 | snapshot | after-echo | 51 |  |
| 6 | input |  | 0 | "pwd\r" |
| 7 | waitFor | pwd-output | 518 | /\// -> match |
| 8 | snapshot | after-pwd | 50 |  |
| 9 | input |  | 0 | "printf \"col1\\tcol2\\tcol3\\n\"\r" |
| 10 | waitFor | tabs | 21 | /col3/ -> match |
| 11 | snapshot | after-tabs | 50 |  |
| 12 | input |  | 0 | "clear\r" |
| 13 | wait |  | 201 |  |
| 14 | snapshot | after-second-clear | 51 |  |
| 15 | input |  | 0 | "exit\r" |

</details>

### snapshot: `after-clear`

- cursor: row=1, col=0 (grid is 24x80)
- altScreen: `false`
- scrollback rows: 0

```
export PS1='>>> ' PS2='... '; clear























```

### snapshot: `after-echo`

- cursor: row=2, col=0 (grid is 24x80)
- altScreen: `false`
- scrollback rows: 0

```
export PS1='>>> ' PS2='... '; clear
echo hello






















```

### snapshot: `after-pwd`

- cursor: row=4, col=4 (grid is 24x80)
- altScreen: `false`
- scrollback rows: 0

```
>>> echo hello
hello
>>> pwd
/Users/jcoeyman/cloudflare/cloudterm
>>>



















```

### snapshot: `after-tabs`

- cursor: row=6, col=4 (grid is 24x80)
- altScreen: `false`
- scrollback rows: 0

```
>>> echo hello
hello
>>> pwd
/Users/jcoeyman/cloudflare/cloudterm
>>> printf "col1\tcol2\tcol3\n"
col1    col2    col3
>>>

















```

### snapshot: `after-second-clear`

- cursor: row=0, col=4 (grid is 24x80)
- altScreen: `false`
- scrollback rows: 0

```
>>>























```

### final state (after scenario cleanup)

- cursor: row=1, col=0 · altScreen: `false`

```
>>> exit























```

## vim — PASS (1.43s)

- bytes received from PTY: 4114
- snapshots: 4
- steps: 16

<details><summary>step trace</summary>

| # | type | label | ms | note |
|---|------|-------|----|------|
| 0 | input |  | 1 | "export PS1='>>> ' PS2='... '; clear\r" |
| 1 | waitFor | initial-prompt | 21 | />>> / -> match |
| 2 | input |  | 0 | "echo MARKER_BEFORE_VIM_42\r" |
| 3 | waitFor | marker-visible | 21 | /MARKER_BEFORE_VIM_42/ -> match |
| 4 | snapshot | main-before-vim | 51 |  |
| 5 | input |  | 0 | "vim -n -u NONE\r" |
| 6 | waitFor | vim-painted | 766 | /~/ -> match |
| 7 | wait |  | 200 |  |
| 8 | snapshot | alt-in-vim | 50 |  |
| 9 | input |  | 0 | "iHELLO_FROM_VIM\u001b" |
| 10 | waitFor | vim-typed | 21 | /HELLO_FROM_VIM/ -> match |
| 11 | snapshot | alt-in-vim-with-text | 51 |  |
| 12 | input |  | 0 | ":q!\r" |
| 13 | waitFor | prompt-after-vim | 21 | />>> / -> match |
| 14 | snapshot | main-after-vim | 51 |  |
| 15 | input |  | 0 | "exit\r" |

</details>

### snapshot: `main-before-vim`

- cursor: row=2, col=0 (grid is 24x80)
- altScreen: `false`
- scrollback rows: 0

```
export PS1='>>> ' PS2='... '; clear
echo MARKER_BEFORE_VIM_42






















```

### snapshot: `alt-in-vim`

- cursor: row=0, col=0 (grid is 24x80)
- altScreen: `true`
- scrollback rows: 0

```

~
~
~
~                              VIM - Vi IMproved
~
~                               version 9.1.1752
~                           by Bram Moolenaar et al.
~                 Vim is open source and freely distributable
~
~                           Sponsor Vim development!
~                type  :help sponsor<Enter>    for information
~
~                type  :q<Enter>               to exit
~                type  :help<Enter>  or  <F1>  for on-line help
~                type  :help version9<Enter>   for version info
~
~                        Running in Vi compatible mode
~                type  :set nocp<Enter>        for Vim defaults
~                type  :help cp-default<Enter> for info on this
~
~
~

```

### snapshot: `alt-in-vim-with-text`

- cursor: row=0, col=13 (grid is 24x80)
- altScreen: `true`
- scrollback rows: 0

```
HELLO_FROM_VIM
~
~
~
~
~
~
~
~
~
~
~
~
~
~
~
~
~
~
~
~
~
~

```

### snapshot: `main-after-vim`

- cursor: row=3, col=4 (grid is 24x80)
- altScreen: `false`
- scrollback rows: 0

```
>>> echo MARKER_BEFORE_VIM_42
MARKER_BEFORE_VIM_42
>>> vim -n -u NONE
>>>




















```

### final state (after scenario cleanup)

- cursor: row=4, col=0 · altScreen: `false`

```
>>> echo MARKER_BEFORE_VIM_42
MARKER_BEFORE_VIM_42
>>> vim -n -u NONE
>>> exit




















```

## less — PASS (1.23s)

- bytes received from PTY: 3216
- snapshots: 4
- steps: 13

<details><summary>step trace</summary>

| # | type | label | ms | note |
|---|------|-------|----|------|
| 0 | input |  | 0 | "export PS1='>>> ' PS2='... '; clear\r" |
| 1 | waitFor | initial-prompt | 20 | />>> / -> match |
| 2 | snapshot | main-before-less | 51 |  |
| 3 | input |  | 0 | "less /etc/passwd\r" |
| 4 | waitFor | less-content | 563 | /(root\|nobody\|daemon):/ -> match |
| 5 | snapshot | in-less | 51 |  |
| 6 | input |  | 0 | " " |
| 7 | wait |  | 251 |  |
| 8 | snapshot | in-less-scrolled | 50 |  |
| 9 | input |  | 0 | "q" |
| 10 | waitFor | prompt-after-less | 21 | />>> / -> match |
| 11 | snapshot | main-after-less | 51 |  |
| 12 | input |  | 0 | "exit\r" |

</details>

### snapshot: `main-before-less`

- cursor: row=1, col=0 (grid is 24x80)
- altScreen: `false`
- scrollback rows: 0

```
export PS1='>>> ' PS2='... '; clear























```

### snapshot: `in-less`

- cursor: row=23, col=11 (grid is 24x80)
- altScreen: `true`
- scrollback rows: 0

```
##
# User Database
#
# Note that this file is consulted directly only when the system is running
# in single-user mode.  At other times this information is provided by
# Open Directory.
#
# See the opendirectoryd(8) man page for additional information about
# Open Directory.
##
nobody:*:-2:-2:Unprivileged User:/var/empty:/usr/bin/false
root:*:0:0:System Administrator:/var/root:/bin/sh
daemon:*:1:1:System Services:/var/root:/usr/bin/false
_uucp:*:4:4:Unix to Unix Copy Protocol:/var/spool/uucp:/usr/sbin/uucico
_taskgated:*:13:13:Task Gate Daemon:/var/empty:/usr/bin/false
_networkd:*:24:24:Network Services:/var/networkd:/usr/bin/false
_installassistant:*:25:25:Install Assistant:/var/empty:/usr/bin/false
_lp:*:26:26:Printing Services:/var/spool/cups:/usr/bin/false
_postfix:*:27:27:Postfix Mail Server:/var/spool/postfix:/usr/bin/false
_scsd:*:31:31:Service Configuration Service:/var/empty:/usr/bin/false
_ces:*:32:32:Certificate Enrollment Service:/var/empty:/usr/bin/false
_appstore:*:33:33:Mac App Store Service:/var/db/appstore:/usr/bin/false
_mcxalr:*:54:54:MCX AppLaunch:/var/empty:/usr/bin/false
/etc/passwd
```

### snapshot: `in-less-scrolled`

- cursor: row=23, col=1 (grid is 24x80)
- altScreen: `true`
- scrollback rows: 0

```
_appleevents:*:55:55:AppleEvents Daemon:/var/empty:/usr/bin/false
_geod:*:56:56:Geo Services Daemon:/var/db/geod:/usr/bin/false
_devdocs:*:59:59:Developer Documentation:/var/empty:/usr/bin/false
_sandbox:*:60:60:Seatbelt:/var/empty:/usr/bin/false
_mdnsresponder:*:65:65:mDNSResponder:/var/empty:/usr/bin/false
_ard:*:67:67:Apple Remote Desktop:/var/empty:/usr/bin/false
_www:*:70:70:World Wide Web Server:/Library/WebServer:/usr/bin/false
_eppc:*:71:71:Apple Events User:/var/empty:/usr/bin/false
_cvs:*:72:72:CVS Server:/var/empty:/usr/bin/false
_svn:*:73:73:SVN Server:/var/empty:/usr/bin/false
_mysql:*:74:74:MySQL Server:/var/empty:/usr/bin/false
_sshd:*:75:75:sshd Privilege separation:/var/empty:/usr/bin/false
_qtss:*:76:76:QuickTime Streaming Server:/var/empty:/usr/bin/false
_cyrus:*:77:6:Cyrus Administrator:/var/imap:/usr/bin/false
_mailman:*:78:78:Mailman List Server:/var/empty:/usr/bin/false
_appserver:*:79:79:Application Server:/var/empty:/usr/bin/false
_clamav:*:82:82:ClamAV Daemon:/var/virusmails:/usr/bin/false
_amavisd:*:83:83:AMaViS Daemon:/var/virusmails:/usr/bin/false
_jabber:*:84:84:Jabber XMPP Server:/var/empty:/usr/bin/false
_appowner:*:87:87:Application Owner:/var/empty:/usr/bin/false
_windowserver:*:88:88:WindowServer:/var/empty:/usr/bin/false
_spotlight:*:89:89:Spotlight:/var/empty:/usr/bin/false
_tokend:*:91:91:Token Daemon:/var/empty:/usr/bin/false
:
```

### snapshot: `main-after-less`

- cursor: row=1, col=4 (grid is 24x80)
- altScreen: `false`
- scrollback rows: 0

```
>>> less /etc/passwd
>>>






















```

### final state (after scenario cleanup)

- cursor: row=2, col=0 · altScreen: `false`

```
>>> less /etc/passwd
>>> exit






















```

## htop — SKIP (8ms)

_skipped: htop not installed_

## tmux — SKIP (5ms)

_skipped: tmux not installed_
