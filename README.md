# wfmu-best-show-downloader

This node.js script will download the best show archive from wfmu.

To start, make sure you have all the appropriate dependencies by calling:

    $ npm install

If everything installs ok, you should be able to run the script:

    $ node download.js

The script automatically downloads 5 episodes at a time, but you can customize that by passing a command line argument:

    $ node download.js 10

All content gets automatically downloaded to a subdirectory named `downloads`.

You can stop the script by using Ctrl+C like any standard command line script. You can resume the download later and it will not re-download stuff you already have locally.
