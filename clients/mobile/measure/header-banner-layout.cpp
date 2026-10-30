// #4839: 앱에 포함된 Yoga로 머리/띠의 좌표를 계산한다. 시뮬레이터·텍스트 렌더는 실행하지 않는다.
#include <yoga/Yoga.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

int main(int argc, char** argv) {
  if (argc != 5) return 2;
  auto config = YGConfigNew();
  // React Native YogaLayoutableShadowNode::layoutTree와 같은 호환 설정.
  YGConfigSetErrata(config, YGErrataAll);
  auto screen = YGNodeNewWithConfig(config);
  auto header = YGNodeNewWithConfig(config);
  auto row = YGNodeNewWithConfig(config);
  auto summary = YGNodeNewWithConfig(config);
  auto banner = YGNodeNewWithConfig(config);
  YGNodeStyleSetWidth(screen, 393);
  YGNodeStyleSetHeight(screen, 852);
  YGNodeInsertChild(screen, header, 0);
  YGNodeStyleSetPadding(header, YGEdgeTop, std::atof(argv[1]));
  YGNodeStyleSetHeight(row, std::atof(argv[2]));
  YGNodeInsertChild(header, row, 0);
  YGNodeStyleSetHeight(summary, std::atof(argv[3]));
  YGNodeInsertChild(header, summary, 1);
  YGNodeStyleSetPositionType(banner, YGPositionTypeAbsolute);
  YGNodeStyleSetHeight(banner, 40);
  YGNodeInsertChild(header, banner, 2);
  if (std::strchr(argv[4], '%')) YGNodeStyleSetPositionPercent(banner, YGEdgeTop, std::atof(argv[4]));
  else YGNodeStyleSetPosition(banner, YGEdgeTop, std::atof(argv[4]));
  YGNodeCalculateLayout(screen, YGUndefined, YGUndefined, YGDirectionLTR);
  std::printf("{\"headerHeight\":%.3f,\"rowBottom\":%.3f,\"bannerTop\":%.3f}\n",
      YGNodeLayoutGetHeight(header),
      YGNodeLayoutGetTop(row) + YGNodeLayoutGetHeight(row),
      YGNodeLayoutGetTop(banner));
  YGNodeFreeRecursive(screen);
  YGConfigFree(config);
}
