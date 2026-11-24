# NSSM Windows service wrapper

`nssm.exe` is the **win64** executable from NSSM **2.24-101-g897c7ad**,
the Windows 10+ compatibility build recommended on the
[official download page](https://nssm.cc/download).

Upstream declares NSSM **public domain**, permitting use and redistribution.
Source code is included in the upstream archive and available through its
[source browser](https://git.nssm.cc/nssm/nssm).

Provenance:

- Download: `https://www.nssm.cc/ci/nssm-2.24-101-g897c7ad.zip`
- Archive SHA-1 (matches the upstream published checksum):
  `ca2f6782a05af85facf9b620e047b01271edd11d`
- Archive SHA-256:
  `99f5045fffbffb745d67fe3a065a953c4a3d9c253b868892d9b685b0ee7d07b8`
- Member: `nssm-2.24-101-g897c7ad/win64/nssm.exe`
- Executable SHA-256:
  `eee9c44c29c2be011f1f1e43bb8c3fca888cb81053022ec5a0060035de16d848`

No local patches were applied. Build scripts check the executable hash. This
small dependency is vendored because the upstream server intermittently returns
HTTP 503; a station installer build must not depend on that server being online.
Existing station upgrades retain their installed NSSM executable and settings.
