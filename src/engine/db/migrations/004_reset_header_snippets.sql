-- 004: snippets made by the header-sync peek (rows whose body was never downloaded) could contain
-- CSS, raw links or encoding leftovers. Clear the ones that look bad and let the background backfill
-- fill them again with the fixed cleaning. Rows with a downloaded body are left alone.
UPDATE message
   SET snippet = '', snippet_checked = 0
 WHERE body_state = 'none'
   AND snippet <> ''
   AND (   snippet LIKE '%@font-face%'
        OR snippet LIKE '%@media%'
        OR snippet LIKE '%@import%'
        OR snippet LIKE '%{%}%'
        OR snippet LIKE '%<http%'
        OR snippet LIKE '%<www.%'
        OR snippet LIKE '%http://%'
        OR snippet LIKE '%https://%'
        OR snippet LIKE '%[image%'
        OR snippet LIKE '%PixelsPerInch%'
        OR snippet GLOB '[0-9]* @*'
        OR snippet GLOB '[0-9]* {*'
        OR snippet GLOB '[0-9]* <*'
        OR snippet LIKE '%<style%'
        OR snippet LIKE '%</%'
        OR snippet LIKE '%view in browser%'
        OR snippet LIKE '%view this email in your browser%');
