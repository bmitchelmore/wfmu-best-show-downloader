# wfmu-best-show-downloader

This node.js script will download the best show archive from wfmu.

To run the script:

    $ node download.js

The script automatically downloads 5 episodes at a time. You can customize that by passing a command line argument:

    $ node download.js 10

You can stop the script by using Ctrl+C like any standard command line script. You can resume the download later and it will not re-download stuff you already have locally.

All content gets automatically downloaded to a subdirectory named `downloads`.
