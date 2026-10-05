# M3 (#3501) test image: the S3 box image plus the box-agent binaries. NOT the production
# image — M2's image build ships momo-box-agent; this layer only lets verify-m3.sh run the
# real binaries under the real box hardening. momo-box-probe is test-only and never ships.
FROM momo-s3-box:local
USER root
COPY momo-box-agent momo-box-probe momo-m3-entry /usr/local/bin/
RUN chmod 0755 /usr/local/bin/momo-box-agent /usr/local/bin/momo-box-probe /usr/local/bin/momo-m3-entry
USER 10001:10001
