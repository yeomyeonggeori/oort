import {createContext, useContext, type RefObject} from 'react';
import type {View} from 'react-native';

export type DecisionStageSource = RefObject<View | null>;
export type OpenDecisionStage = (
  approvalId: string,
  source?: DecisionStageSource,
) => void;
export const DecisionStageEntryContext = createContext<
  OpenDecisionStage | undefined
>(undefined);
/** Cards/chips receive one entry point; current facts and presentation stay in the scope. */
export const useOpenDecisionStage = () => useContext(DecisionStageEntryContext);
